export const CLI_VERSION = '0.1.0';
export const PHALA_CLOUD_API_URL = 'https://cloud-api.phala.network';
export const CLOUD_URL = 'https://cloud.phala.network';
export const TEE_SIMULATOR = 'phalanetwork/tappd-simulator:latest';
export const COMPOSE_FILES_DIR = '.tee-cloud/compose-files';

/**
 * Docker Compose Eliza V2 Template
 *
 * @constant {string} DOCKER_COMPOSE_ELIZA_V2_TEMPLATE - Docker Compose template for setting up Eliza V2 container
 */
export const DOCKER_COMPOSE_ELIZA_V2_TEMPLATE = `version: '3'
services:
  eliza:
    image: {{imageName}}:{{tag}}
    container_name: eliza
    command: >
      bash -c "turbo run build --filter=./packages/core 
      && turbo run build --filter=./packages/*
      && turbo run start --env-mode=loose --filter=@elizaos/the-org"
    stdin_open: true
    tty: true
    volumes:
      - /var/run/tappd.sock:/var/run/tappd.sock
      - eliza:/app/packages/plugin-twitter/src/tweetcache
      - eliza:/app/db.sqlite
    environment:
{{#each envVars}}      - {{{this}}}
{{/each}}
    ports:
      - "3000:3000"
      - "5173:5173"
    restart: always

volumes:
  eliza:`;

/**
 * Docker Compose Eliza v1 Template.
 *
 * @type {string}
 */
export const DOCKER_COMPOSE_ELIZA_V1_TEMPLATE = `version: '3'
services:
  eliza:
    image: {{imageName}}:{{tag}}
    container_name: eliza
    command: >
      /bin/sh -c "
      cd /app &&
      echo {{characterBase64Data}} | base64 -d > characters/{{characterName}}.character.json &&
      bun run start --non-interactive --character=characters/{{characterName}}.character.json
      "
    stdin_open: true
    tty: true
    volumes:
      - /var/run/tappd.sock:/var/run/tappd.sock
      - eliza:/app/packages/plugin-twitter/src/tweetcache
      - eliza:/app/db.sqlite
    environment:
{{#each envVars}}      - {{{this}}}
{{/each}}
    ports:
      - "3000:3000"
    restart: always

volumes:
  eliza:`;
