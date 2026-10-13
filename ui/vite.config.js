import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// In dev, run `node serve-image.js` alongside `npm run dev` — API calls are
// proxied to it. `npm run build` writes ui/dist, which the server serves at /.
// Relative asset paths so the UI also works behind a reverse-proxy path
// prefix (e.g. Traefik at /reflasher) — the server injects a matching <base>.
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
