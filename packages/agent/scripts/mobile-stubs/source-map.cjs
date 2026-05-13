"use strict";

class SourceNode {
  constructor(_line, _column, _source, chunks = "") {
    this.children = [];
    if (chunks) this.add(chunks);
  }

  add(chunk) {
    if (Array.isArray(chunk)) {
      for (const item of chunk) this.add(item);
      return this;
    }
    if (chunk !== undefined && chunk !== null) this.children.push(String(chunk));
    return this;
  }

  prepend(chunk) {
    if (chunk !== undefined && chunk !== null) this.children.unshift(String(chunk));
    return this;
  }

  toString() {
    return this.children.join("");
  }

  toStringWithSourceMap() {
    return {
      code: this.toString(),
      map: {
        toString: () => "",
      },
    };
  }
}

class SourceMapGenerator {
  addMapping() {}
  setSourceContent() {}
  toString() {
    return "";
  }
}

class SourceMapConsumer {}

module.exports = {
  SourceMapConsumer,
  SourceMapGenerator,
  SourceNode,
};
