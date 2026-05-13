"use strict";

class RateLimiter {
  constructor(config, state) {
    this.config = config;
    this.state = state;
  }

  canPost() {
    const maxDay = this.config.maxPostsPerDay;
    if (this.state.postsToday >= maxDay) {
      return false;
    }
    const maxHour = this.config.maxApiCallsPerHour;
    if (this.state.apiCallsThisHour >= maxHour) {
      return false;
    }
    return true;
  }

  getBlockReason() {
    if (this.state.postsToday >= this.config.maxPostsPerDay) {
      return "daily_post_cap";
    }
    if (this.state.apiCallsThisHour >= this.config.maxApiCallsPerHour) {
      return "hourly_api_cap";
    }
    return "rate_limited";
  }
}

module.exports = { RateLimiter };
