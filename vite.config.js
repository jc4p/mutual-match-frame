import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    allowedHosts: true,
    host: '0.0.0.0', // or '0.0.0.0'
    port: 5173, // optional: specify port
  }
})
