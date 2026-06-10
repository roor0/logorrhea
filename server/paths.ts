// Path consolidation: collapse the dynamic/opaque parts of a request path so
// that many similar routes group into one lane instead of a giant list. This
// is what keeps the right-hand column readable when an app serves hundreds of
// hashed asset bundles or id'd API routes.

// Treat a path segment as an opaque id/hash that should be collapsed.
export function looksHashed(s: string): boolean {
  if (/^\d+$/.test(s)) return true; // numeric id            (/users/123)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true; // uuid
  if (/^[0-9a-f]{8,}$/i.test(s)) return true; // hex / content hash
  if (s.length >= 10 && /\d/.test(s) && /[a-z]/i.test(s)) return true; // mixed token (build ids, chunk hashes)
  return false;
}

// Collapse ids, content hashes, and hashed asset filenames:
//   /api/users/123                  -> /api/users/:id
//   /_next/data/usThCZ1.../home.json -> /_next/data/:id/home.json
//   /_next/static/chunks/3a9f2b1c.js -> /_next/static/chunks/*.js
//   /assets/main.4f3a2b.css          -> /assets/*.css
// Readable names (/api/graphql, /dashboard, main.js) are left untouched.
export function normalizePath(p: string): string {
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q); // drop the query string
  const segs = p
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      // Hashed filename: keep the extension, collapse the rest to "*".
      const dot = seg.lastIndexOf('.');
      if (dot > 0) {
        const base = seg.slice(0, dot);
        const ext = seg.slice(dot + 1).toLowerCase();
        if (/^[a-z0-9]{1,5}$/.test(ext) && looksHashed(base)) return `*.${ext}`;
      }
      return looksHashed(seg) ? ':id' : seg;
    });
  return '/' + segs.join('/');
}
