import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `vite dev`, proxy the WebSocket to the local Bun/Elysia backend
// (`bun --watch index.ts` on :8080). In production the same server serves these
// built assets, so the WS is same-origin and no proxy is involved.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
