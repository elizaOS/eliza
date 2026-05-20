/**
 * Swagger/OpenAPI Configuration
 *
 * @module lib/swagger/config
 */

/**
 * Base OpenAPI specification definition
 */
export const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Feed API',
    version: '1.0.0',
    description: 'API documentation for Feed social conspiracy game',
    contact: {
      name: 'API Support',
      url: 'https://github.com/FeedSocial/feed',
    },
  },
  servers: [
    {
      url: process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000',
      description: 'Development server',
    },
    ...(process.env.NEXT_PUBLIC_BASE_URL &&
    process.env.NEXT_PUBLIC_BASE_URL !== 'http://localhost:3000'
      ? []
      : [
          {
            url: 'https://feed.market',
            description: 'Production server',
          },
        ]),
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Steward JWT authentication token',
      },
      CronSecret: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Cron secret for scheduled jobs (CRON_SECRET environment variable)',
      },
    },
  },
};
