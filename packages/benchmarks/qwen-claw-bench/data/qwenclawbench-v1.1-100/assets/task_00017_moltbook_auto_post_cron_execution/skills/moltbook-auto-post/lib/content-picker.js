"use strict";

const fs = require("fs");
const path = require("path");

class ContentPicker {
  constructor(config, queueDir, skillDir) {
    this.config = config;
    this.queueDir = queueDir;
    this.templatesDir = path.join(skillDir, "templates");
  }

  async pick() {
    const mode = (this.config.contentMode || "hybrid").toLowerCase();

    if (mode === "queue") {
      return this._pickFromQueue();
    }
    if (mode === "generate") {
      return this._pickFromTemplates();
    }

    // hybrid: try queue first, then templates
    const fromQueue = await this._pickFromQueue();
    if (fromQueue) {
      return fromQueue;
    }
    return this._pickFromTemplates();
  }

  async _pickFromQueue() {
    if (!fs.existsSync(this.queueDir)) {
      return null;
    }
    let files;
    try {
      files = fs.readdirSync(this.queueDir);
    } catch {
      return null;
    }
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
    if (jsonFiles.length === 0) {
      return null;
    }
    const first = path.join(this.queueDir, jsonFiles[0]);
    try {
      const raw = fs.readFileSync(first, "utf8");
      const data = JSON.parse(raw);
      return {
        text: data.text || "",
        media: data.media || [],
        tags: data.tags || [],
        visibility: data.visibility,
        _queueFile: first,
      };
    } catch {
      return null;
    }
  }

  async _pickFromTemplates() {
    if (!fs.existsSync(this.templatesDir)) {
      return null;
    }
    let files;
    try {
      files = fs.readdirSync(this.templatesDir);
    } catch {
      return null;
    }
    const candidates = files.filter((f) => f.endsWith(".json") || f.endsWith(".md"));
    if (candidates.length === 0) {
      return null;
    }
    return null;
  }
}

module.exports = { ContentPicker };
