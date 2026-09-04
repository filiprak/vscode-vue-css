import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only source tests — never the compiled output in out/.
    include: ["src/**/*.test.ts"],
  },
});
