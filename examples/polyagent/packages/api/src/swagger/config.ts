/**
 * Swagger/OpenAPI Configuration
 *
 * @module lib/swagger/config
 */

/**
 * Base OpenAPI specification definition
 */
export const swaggerDefinition = {
  openapi: "3.0.0",
  info: {
    title: "Polyagent API",
    version: "1.0.0",
    description: "API documentation for Polyagent social conspiracy game",
    contact: {
      name: "API Support",
      url: "https://github.com/Polyagent/polyagent",
    },
  },
  servers: [
    {
      url: process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000",
      description: "Development server",
    },
    ...(process.env.NEXT_PUBLIC_BASE_URL &&
    process.env.NEXT_PUBLIC_BASE_URL !== "http://localhost:3000"
      ? []
      : [
          {
            url: "https://polyagent.game",
            description: "Production server",
          },
        ]),
  ],
  components: {
    securitySchemes: {
      PrivyAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Privy authentication token",
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Bearer authentication token (alias for PrivyAuth)",
      },
      CronSecret: {
        type: "http",
        scheme: "bearer",
        description:
          "Cron secret for scheduled jobs (CRON_SECRET environment variable)",
      },
    },
  },
};
