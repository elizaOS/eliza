/**
 * Example of how to define environment variables with different types in a plugin's package.json
 * 
 * This goes in your plugin's package.json under agentConfig.pluginParameters
 */

export const examplePluginConfig = {
  "agentConfig": {
    "pluginParameters": {
      // String type (default)
      "API_KEY": {
        "type": "string",
        "description": "Your API key for authentication",
        "required": true,
        "sensitive": true
      },
      
      // Boolean type
      "ENABLE_DEBUG": {
        "type": "boolean", 
        "description": "Enable debug logging",
        "required": false,
        "default": false
      },
      
      // Number type
      "PORT": {
        "type": "number",
        "description": "Port number for the service",
        "required": false,
        "default": 3000
      },
      
      // Array type (comma-separated values)
      "ALLOWED_DOMAINS": {
        "type": "array",
        "description": "Comma-separated list of allowed domains",
        "required": false,
        "default": "example.com,api.example.com"
      },
      
      // JSON object type
      "CONFIG_OVERRIDES": {
        "type": "json",
        "description": "JSON object with configuration overrides",
        "required": false,
        "default": "{\"timeout\": 5000, \"retries\": 3}"
      }
    }
  }
};

/**
 * Example of how these values are stored in .env file:
 * 
 * API_KEY=sk-1234567890abcdef
 * ENABLE_DEBUG=true
 * PORT=8080
 * ALLOWED_DOMAINS=domain1.com,domain2.com,domain3.com
 * CONFIG_OVERRIDES={"timeout":10000,"retries":5,"features":{"cache":true}}
 */

/**
 * Example of how to parse these values in your plugin code:
 */
export function parseEnvVariables(runtime: any) {
  // String
  const apiKey = runtime.getSetting('API_KEY'); // "sk-1234567890abcdef"
  
  // Boolean
  const debugEnabled = runtime.getSetting('ENABLE_DEBUG') === 'true'; // true/false
  
  // Number
  const port = Number(runtime.getSetting('PORT')); // 8080
  
  // Array
  const allowedDomains = runtime.getSetting('ALLOWED_DOMAINS')
    ?.split(',')
    .map((d: string) => d.trim())
    .filter((d: string) => d); // ["domain1.com", "domain2.com", "domain3.com"]
  
  // JSON object
  let configOverrides = {};
  try {
    const jsonStr = runtime.getSetting('CONFIG_OVERRIDES');
    if (jsonStr) {
      configOverrides = JSON.parse(jsonStr);
    }
  } catch (error) {
    console.error('Failed to parse CONFIG_OVERRIDES:', error);
  }
  
  return {
    apiKey,
    debugEnabled,
    port,
    allowedDomains,
    configOverrides
  };
} 