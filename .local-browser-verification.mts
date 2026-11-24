import vibelang from "vibelang-vite";
export default {
  plugins: [vibelang()],
  test: { include: ["test/browser-control.test.vibe", "test/page-reader.test.ts"], testTimeout: 60000 },
};
