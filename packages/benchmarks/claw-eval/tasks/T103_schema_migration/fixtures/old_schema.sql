-- Legacy schema (5 tables)

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT,
    full_name TEXT,
    role TEXT,
    created_at TEXT
);

CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL,
    category TEXT
);

CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER,
    total_price REAL,
    status TEXT,
    ordered_at TEXT
);

CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    product_id INTEGER REFERENCES products(id),
    rating INTEGER,
    comment TEXT,
    reviewed_at TEXT
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action TEXT,
    details TEXT,
    logged_at TEXT
);
