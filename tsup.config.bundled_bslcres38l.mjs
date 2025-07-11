// tsup.config.ts
import { defineConfig } from "tsup";
var tsup_config_default = defineConfig({
  entry: ["src/index.ts", "e2e/**/*.test.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json",
  // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ["esm"],
  // Ensure you're targeting CommonJS
  dts: false,
  // Skip DTS generation to avoid external import issues // Ensure you're targeting CommonJS
  external: [
    "dotenv",
    // Externalize dotenv to prevent bundling
    "fs",
    // Externalize fs to use Node.js built-in module
    "path",
    // Externalize other built-ins if necessary
    "https",
    "http",
    "zod"
  ]
});
export {
  tsup_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidHN1cC5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9faW5qZWN0ZWRfZmlsZW5hbWVfXyA9IFwiL1VzZXJzL2FsZXgvZWxpemEtZm9yLWxldnZhLWNsaWVudC90c3VwLmNvbmZpZy50c1wiO2NvbnN0IF9faW5qZWN0ZWRfZGlybmFtZV9fID0gXCIvVXNlcnMvYWxleC9lbGl6YS1mb3ItbGV2dmEtY2xpZW50XCI7Y29uc3QgX19pbmplY3RlZF9pbXBvcnRfbWV0YV91cmxfXyA9IFwiZmlsZTovLy9Vc2Vycy9hbGV4L2VsaXphLWZvci1sZXZ2YS1jbGllbnQvdHN1cC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd0c3VwJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgZW50cnk6IFsnc3JjL2luZGV4LnRzJywgJ2UyZS8qKi8qLnRlc3QudHMnXSxcbiAgb3V0RGlyOiAnZGlzdCcsXG4gIHRzY29uZmlnOiAnLi90c2NvbmZpZy5idWlsZC5qc29uJywgLy8gVXNlIGJ1aWxkLXNwZWNpZmljIHRzY29uZmlnXG4gIHNvdXJjZW1hcDogdHJ1ZSxcbiAgY2xlYW46IHRydWUsXG4gIGZvcm1hdDogWydlc20nXSwgLy8gRW5zdXJlIHlvdSdyZSB0YXJnZXRpbmcgQ29tbW9uSlNcbiAgZHRzOiBmYWxzZSwgLy8gU2tpcCBEVFMgZ2VuZXJhdGlvbiB0byBhdm9pZCBleHRlcm5hbCBpbXBvcnQgaXNzdWVzIC8vIEVuc3VyZSB5b3UncmUgdGFyZ2V0aW5nIENvbW1vbkpTXG4gIGV4dGVybmFsOiBbXG4gICAgJ2RvdGVudicsIC8vIEV4dGVybmFsaXplIGRvdGVudiB0byBwcmV2ZW50IGJ1bmRsaW5nXG4gICAgJ2ZzJywgLy8gRXh0ZXJuYWxpemUgZnMgdG8gdXNlIE5vZGUuanMgYnVpbHQtaW4gbW9kdWxlXG4gICAgJ3BhdGgnLCAvLyBFeHRlcm5hbGl6ZSBvdGhlciBidWlsdC1pbnMgaWYgbmVjZXNzYXJ5XG4gICAgJ2h0dHBzJyxcbiAgICAnaHR0cCcsXG4gICAgJ3pvZCcsXG4gIF0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBb1AsU0FBUyxvQkFBb0I7QUFFalIsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsT0FBTyxDQUFDLGdCQUFnQixrQkFBa0I7QUFBQSxFQUMxQyxRQUFRO0FBQUEsRUFDUixVQUFVO0FBQUE7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLE9BQU87QUFBQSxFQUNQLFFBQVEsQ0FBQyxLQUFLO0FBQUE7QUFBQSxFQUNkLEtBQUs7QUFBQTtBQUFBLEVBQ0wsVUFBVTtBQUFBLElBQ1I7QUFBQTtBQUFBLElBQ0E7QUFBQTtBQUFBLElBQ0E7QUFBQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
