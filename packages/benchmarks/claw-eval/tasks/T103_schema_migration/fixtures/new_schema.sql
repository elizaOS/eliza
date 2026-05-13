-- Target schema (6 tables)
-- Migration must transform old data to match this schema exactly.

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    role_id INTEGER NOT NULL DEFAULT 0,   -- 0=pending, 1=active, 2=admin, 3=inactive
    created_at TEXT NOT NULL
);

CREATE TABLE profiles (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    display_name TEXT NOT NULL DEFAULT 'Anonymous',
    bio TEXT DEFAULT ''
);

CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price_cents INTEGER NOT NULL,    -- price in cents (e.g., 2999)
    category TEXT NOT NULL DEFAULT 'general'
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    total_price_cents INTEGER NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 0,  -- 0=pending, 1=shipped, 2=delivered, 3=cancelled
    ordered_at TEXT NOT NULL
);

CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    rating INTEGER NOT NULL DEFAULT 3 CHECK(rating BETWEEN 1 AND 5),
    comment TEXT DEFAULT '',
    reviewed_at TEXT NOT NULL
);

CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    logged_at TEXT NOT NULL
);
