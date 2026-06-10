// logorrhea visualization engine — the Logstalgia mechanic, in PixiJS.
//
// Source hosts (client IPs) are listed down the LEFT; request paths down the
// RIGHT. Each request is a ball launched from its source's row, flown to its
// path's lane, met by a paddle that tracks the soonest-arriving ball, bounced,
// and faded back. Colour encodes HTTP status; radius encodes response size.
// Busy rows (by hit count) float to the top and persist; cold rows are evicted
// only when a column is full.
//
// Rendering: balls and the paddle are redrawn into a single Graphics each frame
// (immediate-mode, no per-ball object churn); the row labels are retained Text
// objects updated only when the layout changes.
import { Application, Container, Graphics, Text } from 'pixi.js';
import type { Group } from './types';

const SPEED = 520; // ball horizontal speed, px/s
const MAX_BALLS = 700; // hard cap; excess is sampled out
const PER_GROUP_CAP = 64; // max balls drawn for one group (qty beyond is sampled)
const SOURCE_RESERVE = 210; // left px for the source (IP) column
const LABEL_RESERVE = 250; // right px for the paddle + path labels
const TOP_MARGIN = 54; // below the title bar
const BOTTOM_MARGIN = 16;
const LABEL_COLOR = 0xb8c0c8;
const IDLE_FADE_START = 7000; // ms idle before a row (route or IP) starts fading
const IDLE_FADE_DUR = 6000; // ms fade; the row is removed after START + DUR

function statusColor(status: number): number {
  if (status >= 500) return 0xff4d4f;
  if (status >= 400) return 0xffd43b;
  if (status >= 300) return 0x3bc9db;
  if (status >= 200) return 0x35d07f;
  return 0x9aa0a6;
}

function radiusForSize(size: number): number {
  return Math.max(3, Math.min(14, 3 + Math.log10(size + 1) * 1.7));
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// White-hot glow over the resting label colour.
function glowColor(glow: number): number {
  if (glow <= 0) return LABEL_COLOR;
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * glow);
  return (lerp(0xb8, 0xff) << 16) | (lerp(0xc0, 0xff) << 8) | lerp(0xc8, 0xff);
}

type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: number;
  alpha: number;
  laneY: number;
  bounced: boolean;
  status: number;
  delay: number; // ms before this ball launches (staggers a burst into a stream)
};

// Paddle-impact effects.
type Impact = { x: number; y: number; r: number; max: number; color: number; life: number };
type Spark = { x: number; y: number; vx: number; vy: number; color: number; life: number };
type Floater = { label: Text; vy: number; life: number };

// A row in either column (a source IP on the left, or a request path on the right).
type Track = {
  key: string;
  count: number;
  last: number;
  y: number; // current (animated)
  targetY: number;
  label: Text;
  glow: number;
};

export type VizStats = { total: number; rps: number; lanes: number };

export class VizEngine {
  private app = new Application();
  private balls: Ball[] = [];
  private lanes = new Map<string, Track>(); // right: request paths
  private sources = new Map<string, Track>(); // left: client IPs
  private ballLayer = new Graphics();
  private paddleLayer = new Graphics();
  private laneLayer = new Container();
  private sourceLayer = new Container();
  private fxLayer = new Graphics(); // impact rings + sparks
  private fxTextLayer = new Container(); // floating status codes
  private impacts: Impact[] = [];
  private sparks: Spark[] = [];
  private floaters: Floater[] = [];
  private paddleGlow = 0;
  private paddleY = 0;
  private total = 0;
  private recent: { t: number; q: number }[] = [];
  private relayoutAt = 0;
  private statsAt = 0;
  private onStats?: (s: VizStats) => void;
  private destroyed = false;
  private initPromise: Promise<void> | null = null;

  async mount(el: HTMLElement, onStats?: (s: VizStats) => void) {
    this.onStats = onStats;
    this.initPromise = this.app.init({
      resizeTo: el,
      background: 0x05070a,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    await this.initPromise;
    // React StrictMode (dev) unmounts while init is still awaiting; the
    // deferred destroy() below tears the Application down once init settles.
    if (this.destroyed) return;
    el.appendChild(this.app.canvas);
    this.app.stage.addChild(
      this.sourceLayer,
      this.laneLayer,
      this.ballLayer,
      this.paddleLayer,
      this.fxLayer,
      this.fxTextLayer,
    );
    this.paddleY = this.app.screen.height / 2;
    this.app.ticker.add((t) => this.tick(t.deltaMS));
  }

  destroy() {
    this.destroyed = true;
    // Application.init may still be in flight (StrictMode dev double-mount);
    // destroying mid-init throws, so wait for it to settle first.
    this.initPromise?.then(() => this.app.destroy(true, { children: true }));
  }

  private get paddleX() {
    return this.app.screen.width - LABEL_RESERVE;
  }
  private get spawnX() {
    return SOURCE_RESERVE;
  }

  private band() {
    return { top: TOP_MARGIN, height: Math.max(40, this.app.screen.height - TOP_MARGIN - BOTTOM_MARGIN) };
  }
  private cap() {
    return Math.max(6, Math.min(48, Math.floor(this.band().height / 18)));
  }

  addFrame(groups: Group[]) {
    for (const g of groups) this.addGroup(g);
  }

  private addGroup(g: Group) {
    const qty = Math.max(1, g.qty | 0);
    const now = performance.now();
    this.total += qty;
    this.recent.push({ t: now, q: qty });

    const lane = this.track(this.lanes, this.laneLayer, g.path, this.paddleX + 14);
    const newLane = lane.count === 0;
    lane.count += qty; // true volume, even though we draw at most PER_GROUP_CAP balls
    lane.last = now;
    if (newLane) {
      // A freshly (re)created lane starts at screen centre; position it at its
      // real row now so its balls fly to the right side, not the middle.
      this.layoutLanes(now);
      lane.y = lane.targetY;
    }

    // Origin row: the client IP on the left (representative host per group).
    const { top, height } = this.band();
    let baseY: number;
    if (g.host) {
      const src = this.track(this.sources, this.sourceLayer, g.host, 8);
      if (src.count === 0) {
        // New source: lay the column out right away (as layoutLanes does for
        // new lanes) so it lands on a free row near its hash position instead
        // of directly on top of a neighbour.
        this.layoutSources(now);
        src.y = src.targetY;
      }
      src.count += qty;
      src.last = now;
      src.glow = 1;
      baseY = src.y;
    } else {
      baseY = top + hash01(g.path) * height;
    }

    // Expand the group into balls: one per request at low qty (same vis as
    // before), sampled to PER_GROUP_CAP when a group is a flood; bigger bursts
    // fan out vertically around the source row.
    const draw = Math.min(qty, PER_GROUP_CAP);
    const spread = Math.min(height, 18 + qty * 4);
    const color = statusColor(g.status);
    const r = radiusForSize(g.size);
    const targetY = lane.targetY;
    const dist = this.paddleX - this.spawnX;
    // Stagger launches over time and vary speed slightly so a burst reads as a
    // stream of distinct balls rather than one overlapping clump.
    const gap = draw > 1 ? Math.min(45, 520 / draw) : 0;
    for (let i = 0; i < draw; i++) {
      if (this.balls.length >= MAX_BALLS) break;
      const startY = Math.max(top, Math.min(top + height, baseY + (Math.random() - 0.5) * spread));
      const vx = SPEED * (0.82 + Math.random() * 0.36);
      this.balls.push({
        x: this.spawnX,
        y: startY,
        vx,
        vy: (targetY - startY) / (dist / vx),
        r,
        color,
        alpha: 1,
        laneY: targetY,
        bounced: false,
        status: g.status,
        delay: i * gap,
      });
    }
  }

  // Get-or-create a row in a column. Each label owns its style (no shared mutation).
  private track(map: Map<string, Track>, layer: Container, key: string, x: number): Track {
    const existing = map.get(key);
    if (existing) return existing;
    const label = new Text({
      text: key,
      style: { fill: LABEL_COLOR, fontFamily: 'monospace', fontSize: 13 },
    });
    label.anchor.set(0, 0.5);
    label.x = x;
    label.y = this.app.screen.height / 2;
    layer.addChild(label);
    const t: Track = { key, count: 0, last: performance.now(), y: label.y, targetY: label.y, label, glow: 0 };
    map.set(key, t);
    return t;
  }

  // Right column (request paths): busiest on top, idle ones removed once fully
  // faded, coldest evicted if over capacity. Assigns target rows + label text.
  private layoutLanes(now: number) {
    const x = this.paddleX + 14;
    for (const [k, t] of this.lanes) {
      if (now - t.last > IDLE_FADE_START + IDLE_FADE_DUR) {
        t.label.destroy();
        this.lanes.delete(k);
      }
    }
    const cap = this.cap();
    if (this.lanes.size > cap) {
      const coldest = [...this.lanes.values()].sort((a, b) => a.count - b.count).slice(0, this.lanes.size - cap);
      for (const t of coldest) {
        t.label.destroy();
        this.lanes.delete(t.key);
      }
    }
    const tracks = [...this.lanes.values()].sort((a, b) => b.count - a.count);
    const { top, height } = this.band();
    const rowH = Math.min(22, height / Math.max(tracks.length, 1));
    const fontSize = Math.max(9, Math.min(14, rowH - 6));
    tracks.forEach((t, i) => {
      t.targetY = top + (i + 0.5) * rowH;
      t.label.style.fontSize = fontSize;
      t.label.x = x;
      t.label.text = `${t.key}  ${fmtCount(t.count)}`;
    });
  }

  // Left column (source IPs): each row sits at a stable position derived from
  // its IP (spread across the full height), so request origins come from all
  // over rather than bunching at the top. Rows whose hashes land too close are
  // nudged apart so labels never overlap. Idle IPs fade out and drop off like
  // routes; the coldest are evicted if the column is over capacity.
  private layoutSources(now: number) {
    for (const [k, t] of this.sources) {
      if (now - t.last > IDLE_FADE_START + IDLE_FADE_DUR) {
        t.label.destroy();
        this.sources.delete(k);
      }
    }
    const cap = this.cap();
    if (this.sources.size > cap) {
      const coldest = [...this.sources.values()].sort((a, b) => a.count - b.count).slice(0, this.sources.size - cap);
      for (const t of coldest) {
        t.label.destroy();
        this.sources.delete(t.key);
      }
    }
    const { top, height } = this.band();
    const usable = Math.max(20, height - 20);
    const tracks = [...this.sources.values()].sort((a, b) => hash01(a.key) - hash01(b.key));
    const minGap = Math.min(15, usable / Math.max(tracks.length, 1));
    // Forward pass: push collided rows down; backward pass: pull any that
    // overflowed the bottom back up. Hash order is stable, so rows keep their
    // relative placement and only shift by small, animated nudges.
    let prev = -Infinity;
    for (const t of tracks) {
      t.targetY = Math.max(top + 10 + hash01(t.key) * usable, prev + minGap);
      prev = t.targetY;
    }
    let next = top + 10 + usable;
    for (let i = tracks.length - 1; i >= 0; i--) {
      tracks[i].targetY = Math.min(tracks[i].targetY, next);
      next = tracks[i].targetY - minGap;
    }
    for (const t of tracks) {
      t.label.style.fontSize = 12;
      t.label.x = 8;
      t.label.text = `${t.key}  ${fmtCount(t.count)}`;
    }
  }

  // Animate a column toward its target rows. `fade` (lanes only) dims rows that
  // have gone idle, so stale routes fade out before removal.
  private animateColumn(map: Map<string, Track>, dt: number, x: number, now: number, fade: boolean) {
    for (const t of map.values()) {
      t.y += (t.targetY - t.y) * Math.min(1, dt * 8);
      t.label.x = x;
      t.label.y = t.y;
      t.glow = Math.max(0, t.glow - dt * 3);
      t.label.style.fill = glowColor(t.glow);
      if (fade) {
        const idle = now - t.last;
        t.label.alpha = idle <= IDLE_FADE_START ? 1 : Math.max(0, 1 - (idle - IDLE_FADE_START) / IDLE_FADE_DUR);
      }
    }
  }

  // Paddle hit: an expanding flash ring, a fan of sparks, and (for errors, or a
  // sampled fraction of the rest) a floating status code — bigger balls/bursts
  // throw more sparks, so many simultaneous hits read as a bigger explosion.
  private spawnImpact(x: number, y: number, color: number, r: number, status: number) {
    if (this.impacts.length < 140) this.impacts.push({ x, y, r, max: 16 + r * 2.4, color, life: 1 });
    if (this.sparks.length < 600) {
      const n = 3 + Math.min(7, (r / 2) | 0);
      for (let i = 0; i < n; i++) {
        const ang = Math.PI + (Math.random() - 0.5) * 1.7; // fan back to the left
        const sp = 70 + Math.random() * 170;
        this.sparks.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, color, life: 1 });
      }
    }
    if (this.floaters.length < 28 && (status >= 400 || Math.random() < 0.3)) {
      const label = new Text({
        text: String(status),
        style: { fill: color, fontFamily: 'monospace', fontSize: 13 + Math.min(11, r) },
      });
      label.anchor.set(0.5);
      label.x = x - 6;
      label.y = y;
      this.fxTextLayer.addChild(label);
      this.floaters.push({ label, vy: -28 - Math.random() * 22, life: 1 });
    }
  }

  private laneAtY(y: number): Track | undefined {
    let best: Track | undefined;
    let bestD = Infinity;
    for (const lane of this.lanes.values()) {
      const d = Math.abs(lane.targetY - y);
      if (d < bestD) {
        bestD = d;
        best = lane;
      }
    }
    return best;
  }

  private tick(deltaMS: number) {
    const dt = Math.min(deltaMS, 50) / 1000;
    const H = this.app.screen.height;
    const paddleX = this.paddleX;
    const now = performance.now();

    if (now >= this.relayoutAt) {
      this.relayoutAt = now + 1200;
      this.layoutLanes(now);
      this.layoutSources(now);
    }

    this.animateColumn(this.lanes, dt, paddleX + 14, now, true);
    this.animateColumn(this.sources, dt, 8, now, true);

    // Paddle tracks the soonest-arriving incoming ball, easing back to centre
    // when there's nothing in flight.
    let soonest = Infinity;
    let targetPaddleY = H / 2;
    for (const b of this.balls) {
      if (b.bounced) continue;
      const eta = (paddleX - b.x) / SPEED;
      if (eta >= 0 && eta < soonest) {
        soonest = eta;
        targetPaddleY = b.laneY;
      }
    }
    this.paddleY += (targetPaddleY - this.paddleY) * Math.min(1, dt * 9);

    // Advance + draw balls.
    this.ballLayer.clear();
    const next: Ball[] = [];
    for (const b of this.balls) {
      if (b.delay > 0) {
        b.delay -= deltaMS; // still queued; hold at the source until its turn
        next.push(b);
        continue;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (!b.bounced && b.x >= paddleX) {
        b.bounced = true;
        b.x = paddleX;
        b.vx = -SPEED * 0.6;
        b.vy = -b.vy * 0.4 + (Math.random() - 0.5) * 40;
        const lane = this.laneAtY(b.laneY);
        if (lane) lane.glow = 1;
        this.spawnImpact(paddleX, b.y, b.color, b.r, b.status);
        this.paddleGlow = 1;
      }
      if (b.bounced) {
        b.alpha -= dt * 0.9;
        b.r *= 1 - dt * 0.4;
      }
      if (b.alpha <= 0.02 || b.x < this.spawnX - 20 || b.y < -20 || b.y > H + 20) continue;
      this.ballLayer.circle(b.x, b.y, b.r).fill({ color: b.color, alpha: Math.max(0, Math.min(1, b.alpha)) });
      next.push(b);
    }
    this.balls = next;

    // Classic Pong paddle: a solid white rectangle. Fixed size (a fraction of
    // the play height, clamped) so it stays paddle-proportioned and never grows
    // to fill the screen.
    this.paddleGlow = Math.max(0, this.paddleGlow - dt * 3);
    const ph = Math.max(43, Math.min(90, H * 0.078));
    const pw = 14;
    this.paddleLayer.clear();
    if (this.paddleGlow > 0) {
      const g = this.paddleGlow;
      this.paddleLayer
        .roundRect(paddleX - pw / 2 - 7 * g, this.paddleY - ph / 2 - 7 * g, pw + 14 * g, ph + 14 * g, 6)
        .fill({ color: 0xffffff, alpha: 0.32 * g });
    }
    this.paddleLayer.rect(paddleX - pw / 2, this.paddleY - ph / 2, pw, ph).fill({ color: 0xffffff });

    // Impact effects: expanding rings, sparks, and rising status codes.
    this.fxLayer.clear();
    const impacts: Impact[] = [];
    for (const im of this.impacts) {
      im.life -= dt * 2.4;
      if (im.life <= 0) continue;
      const rr = im.r + (im.max - im.r) * (1 - im.life);
      this.fxLayer.circle(im.x, im.y, rr).fill({ color: im.color, alpha: 0.16 * im.life });
      this.fxLayer.circle(im.x, im.y, rr).stroke({ color: 0xffffff, width: 2, alpha: 0.7 * im.life });
      impacts.push(im);
    }
    this.impacts = impacts;
    const sparks: Spark[] = [];
    for (const s of this.sparks) {
      s.life -= dt * 2.5;
      if (s.life <= 0) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 220 * dt; // gravity
      this.fxLayer.circle(s.x, s.y, 1.7).fill({ color: s.color, alpha: Math.max(0, s.life) });
      sparks.push(s);
    }
    this.sparks = sparks;
    const floaters: Floater[] = [];
    for (const f of this.floaters) {
      f.life -= dt * 0.8;
      if (f.life <= 0) {
        f.label.destroy();
        continue;
      }
      f.label.y += f.vy * dt;
      f.label.alpha = Math.max(0, Math.min(1, f.life));
      floaters.push(f);
    }
    this.floaters = floaters;

    while (this.recent.length && now - this.recent[0].t > 1000) this.recent.shift();
    if (this.onStats && now >= this.statsAt) {
      this.statsAt = now + 400;
      const rps = this.recent.reduce((s, r) => s + r.q, 0);
      this.onStats({ total: this.total, rps, lanes: this.lanes.size });
    }
  }
}
