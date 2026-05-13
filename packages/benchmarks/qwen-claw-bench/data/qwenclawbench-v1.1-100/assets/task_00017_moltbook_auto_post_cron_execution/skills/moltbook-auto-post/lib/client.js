"use strict";

/**
 * Stub client for benchmark workspace — no outbound calls are made when
 * CONTENT_MODE yields no draft (normal no_content path).
 */
class MoltbookClient {
  constructor(_config) {}

  async uploadMedia(_mediaPath) {
    throw new Error("uploadMedia not used in benchmark dry path");
  }

  async createPost(_payload) {
    throw new Error("createPost not used in benchmark dry path");
  }
}

module.exports = { MoltbookClient };
