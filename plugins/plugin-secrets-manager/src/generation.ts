import { logger } from "@elizaos/core";
import type { GenerationScript } from "./types";

/**
 * Script templates for generating different types of environment variables
 */
export const generationTemplates = {
  private_key: {
    rsa: `
const crypto = require('crypto');
const { generateKeyPairSync } = crypto;

try {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { 
      type: 'pkcs8', 
      format: 'pem' 
    }
  });
  
  console.log(privateKey);
} catch (error) {
  console.error('Error generating RSA key:', error.message);
  process.exit(1);
}
    `,

    ed25519: `
const crypto = require('crypto');
const { generateKeyPairSync } = crypto;

try {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { 
      type: 'pkcs8', 
      format: 'pem' 
    }
  });
  
  console.log(privateKey);
} catch (error) {
  console.error('Error generating Ed25519 key:', error.message);
  process.exit(1);
}
    `,
  },

  secret: {
    uuid: `
const { v4: uuidv4 } = require('uuid');

try {
  console.log(uuidv4());
} catch (error) {
  console.error('Error generating UUID:', error.message);
  process.exit(1);
}
    `,

    hex_32: `
const crypto = require('crypto');

try {
  console.log(crypto.randomBytes(32).toString('hex'));
} catch (error) {
  console.error('Error generating hex secret:', error.message);
  process.exit(1);
}
    `,

    base64_32: `
const crypto = require('crypto');

try {
  console.log(crypto.randomBytes(32).toString('base64'));
} catch (error) {
  console.error('Error generating base64 secret:', error.message);
  process.exit(1);
}
    `,

    jwt_secret: `
const crypto = require('crypto');

try {
  // Generate a 256-bit (32-byte) secret for JWT signing
  const secret = crypto.randomBytes(32).toString('base64url');
  console.log(secret);
} catch (error) {
  console.error('Error generating JWT secret:', error.message);
  process.exit(1);
}
    `,
  },

  config: {
    port: `
// Generate a random port number between 3000-9999
const port = Math.floor(Math.random() * (9999 - 3000 + 1)) + 3000;
console.log(port.toString());
    `,

    database_name: `
const crypto = require('crypto');

try {
  // Generate a database name with timestamp and random suffix
  const timestamp = Date.now();
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const dbName = \`app_db_\${timestamp}_\${randomSuffix}\`;
  console.log(dbName);
} catch (error) {
  console.error('Error generating database name:', error.message);
  process.exit(1);
}
    `,
  },
};

/**
 * Dependencies required for different generation types
 */
export const generationDependencies = {
  private_key: [], // crypto is built-in
  secret: {
    uuid: ["uuid"],
    hex_32: [],
    base64_32: [],
    jwt_secret: [],
  },
  config: {
    port: [],
    database_name: [],
  },
};

/**
 * Determines if an environment variable can be auto-generated
 */
export function canGenerateEnvVar(
  varName: string,
  type: string,
  description?: string,
): boolean {
  const lowerName = varName.toLowerCase();
  const lowerDesc = description?.toLowerCase() || "";

  // Check for private keys
  if (
    type === "private_key" ||
    lowerName.includes("private_key") ||
    lowerDesc.includes("private key")
  ) {
    return true;
  }

  // Check for secrets
  if (
    type === "secret" ||
    lowerName.includes("secret") ||
    lowerName.includes("key")
  ) {
    // Don't generate API keys - those need to come from external services
    if (lowerName.includes("api_key") || lowerDesc.includes("api key")) {
      return false;
    }
    return true;
  }

  // Check for config values
  if (type === "config") {
    if (lowerName.includes("port") || lowerName.includes("database_name")) {
      return true;
    }
  }

  // Check for UUIDs
  if (lowerName.includes("uuid") || lowerName.includes("id")) {
    return true;
  }

  return false;
}

/**
 * Generates a script for creating an environment variable
 */
export function generateScript(
  varName: string,
  type: string,
  pluginName: string,
  description?: string,
): GenerationScript | null {
  const lowerName = varName.toLowerCase();
  const lowerDesc = description?.toLowerCase() || "";

  let script: string | null = null;
  let dependencies: string[] = [];

  // Determine script type based on variable characteristics
  if (type === "private_key" || lowerName.includes("private_key")) {
    if (lowerDesc.includes("ed25519") || lowerName.includes("ed25519")) {
      script = generationTemplates.private_key.ed25519;
    } else {
      script = generationTemplates.private_key.rsa; // Default to RSA
    }
    dependencies = generationDependencies.private_key;
  } else if (lowerName.includes("uuid") || lowerName.includes("id")) {
    script = generationTemplates.secret.uuid;
    dependencies = generationDependencies.secret.uuid;
  } else if (lowerName.includes("jwt") && lowerName.includes("secret")) {
    script = generationTemplates.secret.jwt_secret;
    dependencies = generationDependencies.secret.jwt_secret;
  } else if (type === "secret" || lowerName.includes("secret")) {
    if (lowerDesc.includes("base64") || lowerName.includes("base64")) {
      script = generationTemplates.secret.base64_32;
    } else {
      script = generationTemplates.secret.hex_32; // Default to hex
    }
    dependencies = generationDependencies.secret.hex_32;
  } else if (lowerName.includes("port")) {
    script = generationTemplates.config.port;
    dependencies = generationDependencies.config.port;
  } else if (lowerName.includes("database") && lowerName.includes("name")) {
    script = generationTemplates.config.database_name;
    dependencies = generationDependencies.config.database_name;
  }

  if (!script) {
    logger.warn(
      `No generation script available for ${varName} of type ${type}`,
    );
    return null;
  }

  return {
    variableName: varName,
    pluginName,
    script: script.trim(),
    dependencies,
    attempts: 0,
    status: "pending",
    createdAt: Date.now(),
  };
}

/**
 * Gets a human-readable description of what will be generated
 */
export function getGenerationDescription(
  varName: string,
  type: string,
): string {
  const lowerName = varName.toLowerCase();

  if (type === "private_key" || lowerName.includes("private_key")) {
    if (lowerName.includes("ed25519")) {
      return "Generate a new Ed25519 private key for cryptographic operations";
    } else {
      return "Generate a new RSA private key for cryptographic operations";
    }
  } else if (lowerName.includes("uuid")) {
    return "Generate a new UUID (Universally Unique Identifier)";
  } else if (lowerName.includes("jwt") && lowerName.includes("secret")) {
    return "Generate a secure secret for JWT token signing";
  } else if (type === "secret" || lowerName.includes("secret")) {
    return "Generate a cryptographically secure random secret";
  } else if (lowerName.includes("port")) {
    return "Generate a random port number for the application";
  } else if (lowerName.includes("database") && lowerName.includes("name")) {
    return "Generate a unique database name";
  }

  return "Generate a value for this environment variable";
}
