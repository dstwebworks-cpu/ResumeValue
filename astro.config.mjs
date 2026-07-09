// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Real domain (owned 07/04/2026, Wix registrar) — canonical URLs + sitemap resolve
// here. The site still DEPLOYS only after validation passes (locked rule).
// Windows/Dropbox only: build artifacts + Vite's churny dep cache go to temp,
// otherwise Dropbox locks files mid-rename and the build fails (EBUSY). On CI
// (linux) the defaults apply — a hardcoded C:/ path would break the build there.
const onWindows = process.platform === 'win32';

export default defineConfig({
  site: 'https://www.adaptiveresume.com',
  integrations: [sitemap()],
  ...(onWindows ? {
    outDir: 'C:/Users/dammu/AppData/Local/Temp/rb-dist',
    vite: { cacheDir: 'C:/Users/dammu/AppData/Local/Temp/rb-vite-cache' },
  } : {}),
});
