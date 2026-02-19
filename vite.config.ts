import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // 1. Build into a local 'dist' folder
    outDir: 'dist',
    // 2. Clear it every time so old junk doesn't stick around
    emptyOutDir: true, 
    rollupOptions: {
      input: {
        // Your React Dashboard
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        // This keeps the filenames predictable (optional but helpful)
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    },
  },
})