import { defineConfig } from "cypress";

export default defineConfig({
	e2e: {
		baseUrl: "http://localhost:3000",
		supportFile: "cypress/support/e2e.ts",
		specPattern: "cypress/e2e/**/*.cy.{js,jsx,ts,tsx}",
		viewportWidth: 1280,
		viewportHeight: 720,
		video: false,
		screenshotOnRunFailure: false,
	},
	component: {
		devServer: {
			framework: "react",
			bundler: "vite",
		},
		specPattern: "src/**/*.cy.{js,jsx,ts,tsx}",
	},
});
