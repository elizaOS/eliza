// Type declaration for optional swagger-jsdoc module
// swagger-jsdoc is an optional dev dependency for docs generation
declare module "swagger-jsdoc" {
  type SwaggerJsdocOptions = {
    definition: Record<string, unknown>;
    apis: string[];
  };
  type SwaggerJsdocFunction = (
    options: SwaggerJsdocOptions,
  ) => Record<string, unknown>;
  const swaggerJsdoc: SwaggerJsdocFunction;
  export default swaggerJsdoc;
}
