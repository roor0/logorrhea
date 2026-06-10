import { useEffect, useRef, useState } from 'react';
import { VizEngine, type VizStats } from './viz';
import type { ServerMsg } from './types';

const LEGEND: [string, string][] = [
  ['2xx', '#35d07f'],
  ['3xx', '#3bc9db'],
  ['4xx', '#ffd43b'],
  ['5xx', '#ff4d4f'],
];

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState('live traffic');
  const [stats, setStats] = useState<VizStats>({ total: 0, rps: 0, lanes: 0 });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const engine = new VizEngine();
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    engine.mount(el, setStats);

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'config') setTitle(msg.title);
        else if (msg.type === 'frame') engine.addFrame(msg.groups);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      engine.destroy();
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Title bar */}
      <div style={bar}>
        <span style={{ fontWeight: 600, letterSpacing: 0.5 }}>
          log<span style={{ color: '#3bc9db' }}>orrhea</span>
        </span>
        <span style={{ opacity: 0.6 }}>·</span>
        <span style={{ opacity: 0.85 }}>{title}</span>
        <span style={{ flex: 1 }} />
        <Stat label="req/s" value={stats.rps} />
        <Stat label="total" value={stats.total.toLocaleString()} />
        <Stat label="paths" value={stats.lanes} />
        <span style={{ ...dot, background: connected ? '#35d07f' : '#ff4d4f' }} />
      </div>

      {/* Status legend */}
      <div style={legend}>
        {LEGEND.map(([k, c]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 9, background: c }} />
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 16, fontWeight: 600, color: '#e8eef4' }}>{value}</span>
      <span style={{ fontSize: 11, opacity: 0.55 }}>{label}</span>
    </span>
  );
}

const bar: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 38,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '0 14px',
  fontSize: 13,
  background: 'linear-gradient(180deg, rgba(5,7,10,0.95), rgba(5,7,10,0))',
  pointerEvents: 'none',
};

const legend: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: 14,
  display: 'flex',
  gap: 14,
  fontSize: 11,
  opacity: 0.7,
  pointerEvents: 'none',
};

const dot: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 10,
  marginLeft: 4,
  boxShadow: '0 0 6px currentColor',
};
