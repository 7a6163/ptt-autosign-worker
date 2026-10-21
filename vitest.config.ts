import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Run tests inside workerd so TextDecoder("big5"), WebSocketPair and
// crypto.subtle.timingSafeEqual behave as in production.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
});
