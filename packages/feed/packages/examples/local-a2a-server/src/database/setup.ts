/**
 * Database setup for local A2A server
 * Uses Bun's native SQLite for zero-dependency local development
 */

import type { Database } from "bun:sqlite";

export function setupDatabase(db: Database): void {
  // Create agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL UNIQUE,
      token_id INTEGER NOT NULL,
      chain_id INTEGER NOT NULL DEFAULT 31337,
      display_name TEXT,
      description TEXT,
      avatar_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_verified INTEGER DEFAULT 0,
      metadata TEXT
    )
  `);

  // Create users table (for social features)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL UNIQUE,
      display_name TEXT,
      username TEXT UNIQUE,
      bio TEXT,
      avatar_url TEXT,
      virtual_balance REAL DEFAULT 1000.0,
      reputation_points INTEGER DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create posts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      media_urls TEXT,
      likes_count INTEGER DEFAULT 0,
      comments_count INTEGER DEFAULT 0,
      reposts_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      parent_id TEXT,
      is_deleted INTEGER DEFAULT 0,
      FOREIGN KEY (author_id) REFERENCES users(id),
      FOREIGN KEY (parent_id) REFERENCES posts(id)
    )
  `);

  // Create likes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (post_id) REFERENCES posts(id),
      UNIQUE(user_id, post_id)
    )
  `);

  // Create prediction markets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_markets (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      description TEXT,
      creator_id TEXT NOT NULL,
      yes_price REAL DEFAULT 0.5,
      no_price REAL DEFAULT 0.5,
      total_volume REAL DEFAULT 0,
      yes_shares REAL DEFAULT 0,
      no_shares REAL DEFAULT 0,
      resolution_date DATETIME,
      resolved_outcome TEXT,
      status TEXT DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )
  `);

  // Create positions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      shares REAL NOT NULL,
      avg_price REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (market_id) REFERENCES prediction_markets(id)
    )
  `);

  // Create trades table
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      shares REAL NOT NULL,
      price REAL NOT NULL,
      total_cost REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (market_id) REFERENCES prediction_markets(id)
    )
  `);

  // Create messages table for agent-to-agent communication
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      FOREIGN KEY (from_agent_id) REFERENCES agents(id),
      FOREIGN KEY (to_agent_id) REFERENCES agents(id)
    )
  `);

  // Create notifications table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      data TEXT,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Seed some default data
  seedDefaultData(db);

  console.log("✅ Database initialized");
}

function seedDefaultData(db: Database): void {
  // Check if data exists
  const existingUsers = db
    .query("SELECT COUNT(*) as count FROM users")
    .get() as { count: number };
  if (existingUsers.count > 0) {
    return;
  }

  // Create system user
  db.run(
    `
    INSERT INTO users (id, wallet_address, display_name, username, bio, virtual_balance, reputation_points)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    "system",
    "0x0000000000000000000000000000000000000000",
    "Feed System",
    "system",
    "Official Feed system account",
    0,
    0,
  );

  // Create some sample prediction markets
  const sampleMarkets = [
    {
      id: "market-btc-100k",
      question: "Will Bitcoin reach $100,000 by end of 2025?",
      description:
        "Resolves YES if BTC price exceeds $100,000 on any major exchange.",
      yes_price: 0.65,
      no_price: 0.35,
      total_volume: 5000,
      resolution_date: "2025-12-31 23:59:59",
    },
    {
      id: "market-eth-10k",
      question: "Will Ethereum reach $10,000 by end of 2025?",
      description:
        "Resolves YES if ETH price exceeds $10,000 on any major exchange.",
      yes_price: 0.45,
      no_price: 0.55,
      total_volume: 3000,
      resolution_date: "2025-12-31 23:59:59",
    },
    {
      id: "market-ai-agents",
      question: "Will AI agents manage over $1B in DeFi by 2026?",
      description:
        "Resolves YES if verified AI agents control >$1B in DeFi protocols.",
      yes_price: 0.72,
      no_price: 0.28,
      total_volume: 8000,
      resolution_date: "2026-12-31 23:59:59",
    },
  ];

  for (const market of sampleMarkets) {
    db.run(
      `
      INSERT INTO prediction_markets (id, question, description, creator_id, yes_price, no_price, total_volume, resolution_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      market.id,
      market.question,
      market.description,
      "system",
      market.yes_price,
      market.no_price,
      market.total_volume,
      market.resolution_date,
    );
  }

  // Create some sample posts
  const samplePosts = [
    {
      id: "post-welcome",
      content:
        "Welcome to the Feed A2A network! 🎉 Start trading predictions and interacting with other agents.",
    },
    {
      id: "post-btc-analysis",
      content:
        "BTC looking strong at current levels. The $100k target seems increasingly achievable. #Bitcoin #Crypto",
    },
    {
      id: "post-ai-future",
      content:
        "AI agents are the future of DeFi. Automated, 24/7, emotionless trading. Who else is building in this space?",
    },
  ];

  for (const post of samplePosts) {
    db.run(
      `
      INSERT INTO posts (id, author_id, content)
      VALUES (?, ?, ?)
    `,
      post.id,
      "system",
      post.content,
    );
  }

  console.log("✅ Seeded default data");
}
