/**
 * Real-PGlite tests proving `RuntimeMigrator` never loses existing rows when
 * a schema changes underneath it — column additions, safe type widenings,
 * foreign-key tables, JSON/array columns, large (1000-row) batches, and a
 * destructive rename that must be rejected while leaving prior data intact.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeMigrator } from "../../runtime-migrator/runtime-migrator";
import type { DrizzleDB } from "../../runtime-migrator/types";

describe("Data Persistence Through Migrations", () => {
  let pgClient: PGlite;
  let db: DrizzleDB;
  let migrator: RuntimeMigrator;

  beforeEach(async () => {
    pgClient = new PGlite({ extensions: { vector } });
    db = drizzle(pgClient);
    migrator = new RuntimeMigrator(db);
    await migrator.initialize();
  });

  afterEach(async () => {
    await pgClient.close();
  });

  describe("Critical Data Persistence Scenarios", () => {
    it("should preserve ALL data through column additions", async () => {
      await db.execute(sql`
        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const customerData: Array<{ id: number; name: string; email: string }> = [];
      for (let i = 1; i <= 100; i++) {
        customerData.push({
          id: i,
          name: `Customer ${i}`,
          email: `customer${i}@example.com`,
        });
      }

      for (const customer of customerData) {
        await db.execute(sql`
          INSERT INTO customers (name, email) 
          VALUES (${customer.name}, ${customer.email})
        `);
      }

      const initialCount = await db.execute(sql`SELECT COUNT(*) as count FROM customers`);
      expect(Number(initialCount.rows[0].count)).toBe(100);

      const customersTable = pgTable("customers", {
        id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
        name: text("name").notNull(),
        email: text("email").notNull().unique(),
        created_at: timestamp("created_at").defaultNow(),
        phone: varchar("phone", { length: 20 }),
        address: text("address"),
        is_active: boolean("is_active").default(true),
        metadata: jsonb("metadata"),
      });

      const schema = { customers: customersTable };

      await migrator.migrate("@elizaos/plugin-sql", schema, {
        verbose: false,
        force: true,
      });

      const afterMigration = await db.execute(sql`
        SELECT * FROM customers 
        ORDER BY id
      `);

      expect(afterMigration.rows).toHaveLength(100);

      for (let i = 0; i < 100; i++) {
        const row = afterMigration.rows[i];
        expect(row.id).toBe(i + 1);
        expect(row.name).toBe(`Customer ${i + 1}`);
        expect(row.email).toBe(`customer${i + 1}@example.com`);
        expect(row.created_at).toBeDefined();
        expect(row.is_active).toBe(true);
        expect(row.phone).toBeNull();
        expect(row.address).toBeNull();
        expect(row.metadata).toBeNull();
      }

      const status = await migrator.getStatus("@elizaos/plugin-sql");
      expect(status.hasRun).toBe(true);
      expect(status.snapshots).toBeGreaterThan(0);
      expect(status.journal).toBeDefined();
      expect(status.journal?.entries).toHaveLength(2); // One for introspection, one for migration
    });

    it("should preserve data through column type changes that are safe", async () => {
      await db.execute(sql`
        CREATE TABLE products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          price INTEGER NOT NULL,
          stock INTEGER DEFAULT 0
        )
      `);

      const products = [
        { name: "Product A", price: 1999, stock: 100 },
        { name: "Product B", price: 2999, stock: 50 },
        { name: "Product C", price: 3999, stock: 25 },
        { name: "Product D", price: 4999, stock: 10 },
        { name: "Product E", price: 5999, stock: 5 },
      ];

      for (const product of products) {
        await db.execute(sql`
          INSERT INTO products (name, price, stock) 
          VALUES (${product.name}, ${product.price}, ${product.stock})
        `);
      }

      const productsTable = pgTable("products", {
        id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
        name: text("name").notNull(),
        price: numeric("price", { precision: 10, scale: 2 }).notNull(), // Changed from INTEGER
        stock: integer("stock").default(0),
        description: text("description"), // New column
      });

      const schema = { products: productsTable };

      await migrator.migrate("@elizaos/plugin-sql", schema, {
        verbose: false,
        force: true,
      });

      const result = await db.execute(sql`
        SELECT * FROM products ORDER BY id
      `);

      expect(result.rows).toHaveLength(5);
      expect(result.rows[0].name).toBe("Product A");
      expect(result.rows[0].price).toBe("1999.00"); // Numeric type returns as string with precision
      expect(result.rows[0].stock).toBe(100);
      expect(result.rows[1].name).toBe("Product B");
      expect(result.rows[1].price).toBe("2999.00");
    });

    it("should preserve data in related tables with foreign keys", async () => {
      await db.execute(sql`
        CREATE TABLE departments (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          budget NUMERIC(12,2)
        )
      `);

      await db.execute(sql`
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          department_id INTEGER REFERENCES departments(id),
          salary NUMERIC(10,2),
          hired_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const deptIds: number[] = [];
      const departments = ["Engineering", "Sales", "Marketing", "HR"];
      for (const dept of departments) {
        const result = await db.execute(sql`
          INSERT INTO departments (name, budget) 
          VALUES (${dept}, ${Math.random() * 1000000})
          RETURNING id
        `);
        deptIds.push(result.rows[0].id as number);
      }

      for (let i = 1; i <= 50; i++) {
        const deptId = deptIds[Math.floor(Math.random() * deptIds.length)];
        await db.execute(sql`
          INSERT INTO employees (name, email, department_id, salary) 
          VALUES (
            ${`Employee ${i}`}, 
            ${`employee${i}@company.com`},
            ${deptId},
            ${50000 + Math.random() * 100000}
          )
        `);
      }

      const empCount = await db.execute(sql`SELECT COUNT(*) as count FROM employees`);
      expect(Number(empCount.rows[0].count)).toBe(50);

      const deptCount = await db.execute(sql`SELECT COUNT(*) as count FROM departments`);
      expect(Number(deptCount.rows[0].count)).toBe(4);

      const departmentsTable = pgTable("departments", {
        id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
        name: text("name").notNull(),
        budget: numeric("budget", { precision: 12, scale: 2 }),
        created_at: timestamp("created_at").defaultNow(), // New column
        is_active: boolean("is_active").default(true), // New column
      });

      const employeesTable = pgTable("employees", {
        id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
        name: text("name").notNull(),
        email: text("email").notNull().unique(),
        department_id: integer("department_id").references(() => departmentsTable.id),
        salary: numeric("salary", { precision: 10, scale: 2 }),
        hired_at: timestamp("hired_at").defaultNow(),
        position: text("position"), // New column
        is_active: boolean("is_active").default(true), // New column
      });

      const schema = {
        departments: departmentsTable,
        employees: employeesTable,
      };

      await migrator.migrate("@elizaos/plugin-sql", schema, {
        verbose: false,
        force: true,
      });

      const employeesAfter = await db.execute(sql`
        SELECT e.*, d.name as dept_name 
        FROM employees e
        LEFT JOIN departments d ON e.department_id = d.id
        ORDER BY e.id
      `);

      expect(employeesAfter.rows).toHaveLength(50);

      for (const emp of employeesAfter.rows) {
        expect(emp.dept_name).toBeDefined();
        expect(departments).toContain(emp.dept_name as string);
        expect(emp.is_active).toBe(true); // New column should have default
      }

      const deptsAfter = await db.execute(sql`
        SELECT * FROM departments ORDER BY id
      `);
      expect(deptsAfter.rows).toHaveLength(4);
      for (const dept of deptsAfter.rows) {
        expect(dept.is_active).toBe(true); // New column should have default
      }
    });

    it("should handle migration rollback on failure without data loss", async () => {
      await db.execute(sql`
        CREATE TABLE transactions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          amount NUMERIC(10,2) NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const transactionIds: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const result = await db.execute(sql`
          INSERT INTO transactions (amount, status) 
          VALUES (${100 * i}, 'completed')
          RETURNING id
        `);
        transactionIds.push(result.rows[0].id as string);
      }

      const initialData = await db.execute(sql`
        SELECT * FROM transactions ORDER BY amount
      `);
      expect(initialData.rows).toHaveLength(10);

      // `id: integer` conflicts with the existing UUID column, so this
      // migration must be rejected as destructive rather than applied.
      const badSchema = pgTable("transactions", {
        id: integer("id").primaryKey(),
        amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
        status: text("status").notNull(),
        created_at: timestamp("created_at").defaultNow(),
      });

      try {
        await migrator.migrate(
          "@elizaos/plugin-sql",
          { transactions: badSchema },
          {
            verbose: false,
            force: false,
          }
        );
        expect(true).toBe(false); // Unreachable: migrate() above must throw.
      } catch (error) {
        expect((error as Error).message).toContain("Destructive migration blocked");
      }

      const afterFailure = await db.execute(sql`
        SELECT * FROM transactions ORDER BY amount
      `);
      expect(afterFailure.rows).toHaveLength(10);

      for (let i = 0; i < 10; i++) {
        expect(afterFailure.rows[i].amount).toBe(`${String(100 * (i + 1))}.00`); // Numeric includes precision
        expect(afterFailure.rows[i].status).toBe("completed");
        expect(transactionIds).toContain(afterFailure.rows[i].id as string);
      }
    });

    it("should correctly track migration history through multiple changes", async () => {
      const ordersV1 = pgTable("orders", {
        id: serial("id").primaryKey(),
        total: integer("total").notNull(),
      });

      await migrator.migrate("@elizaos/plugin-sql", { orders: ordersV1 }, { verbose: false });

      for (let i = 1; i <= 5; i++) {
        await db.execute(sql`
          INSERT INTO orders (total) VALUES (${i * 100})
        `);
      }

      // V2: adds customer_name.
      const ordersV2 = pgTable("orders", {
        id: serial("id").primaryKey(),
        total: integer("total").notNull(),
        customer_name: text("customer_name"),
      });

      await migrator.migrate("@elizaos/plugin-sql", { orders: ordersV2 }, { verbose: false });

      // V3: adds status and created_at.
      const ordersV3 = pgTable("orders", {
        id: serial("id").primaryKey(),
        total: integer("total").notNull(),
        customer_name: text("customer_name"),
        status: varchar("status", { length: 20 }).default("pending"),
        created_at: timestamp("created_at").defaultNow(),
      });

      await migrator.migrate("@elizaos/plugin-sql", { orders: ordersV3 }, { verbose: false });

      const finalData = await db.execute(sql`
        SELECT * FROM orders ORDER BY id
      `);

      expect(finalData.rows).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(finalData.rows[i].id).toBe(i + 1);
        expect(finalData.rows[i].total).toBe((i + 1) * 100);
        expect(finalData.rows[i].status).toBe("pending"); // Default value
      }

      const status = await migrator.getStatus("@elizaos/plugin-sql");
      expect(status.hasRun).toBe(true);
      expect(status.journal?.entries).toHaveLength(3); // One per migrate() call above.
      expect(status.snapshots).toBe(3);

      const journalEntries = status.journal?.entries || [];
      expect(journalEntries[0].idx).toBe(0);
      expect(journalEntries[1].idx).toBe(1);
      expect(journalEntries[2].idx).toBe(2);
    });

    it("should handle complex data with JSON and arrays correctly", async () => {
      await db.execute(sql`
        CREATE TABLE user_profiles (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT NOT NULL,
          settings JSONB NOT NULL,
          tags TEXT[] DEFAULT '{}',
          metadata JSONB
        )
      `);

      const profiles = [
        {
          username: "user1",
          settings: { theme: "dark", notifications: true, language: "en" },
          tags: ["admin", "developer"],
          metadata: { lastLogin: "2024-01-01", loginCount: 42 },
        },
        {
          username: "user2",
          settings: { theme: "light", notifications: false, language: "es" },
          tags: ["user", "beta-tester"],
          metadata: { lastLogin: "2024-01-02", loginCount: 15 },
        },
        {
          username: "user3",
          settings: { theme: "auto", notifications: true, language: "fr" },
          tags: ["moderator"],
          metadata: null,
        },
      ];

      for (const profile of profiles) {
        // Postgres array literals need the `{"a","b"}` text form, not JSON.
        const tagsLiteral = profile.tags
          ? `{${profile.tags.map((t) => `"${t}"`).join(",")}}`
          : "{}";

        await db.execute(
          sql.raw(`
          INSERT INTO user_profiles (username, settings, tags, metadata) 
          VALUES (
            '${profile.username}', 
            '${JSON.stringify(profile.settings)}'::jsonb,
            '${tagsLiteral}'::text[],
            ${profile.metadata ? `'${JSON.stringify(profile.metadata)}'::jsonb` : "NULL"}
          )
        `)
        );
      }

      const userProfilesTable = pgTable("user_profiles", {
        id: uuid("id").primaryKey().defaultRandom(),
        username: text("username").notNull(),
        settings: jsonb("settings").notNull(),
        tags: text("tags").array().default(sql`'{}'::text[]`),
        metadata: jsonb("metadata"),
        created_at: timestamp("created_at").defaultNow(), // New column
        is_verified: boolean("is_verified").default(false), // New column
      });

      const schema = { user_profiles: userProfilesTable };

      await migrator.migrate("@elizaos/plugin-sql", schema, {
        verbose: false,
        force: true,
      });

      const result = await db.execute(sql`
        SELECT * FROM user_profiles ORDER BY username
      `);

      expect(result.rows).toHaveLength(3);

      const user1 = result.rows[0];
      expect(user1.username).toBe("user1");
      expect(user1.settings).toEqual({
        theme: "dark",
        notifications: true,
        language: "en",
      });
      expect(user1.tags).toEqual(["admin", "developer"]);
      expect(user1.metadata).toEqual({
        lastLogin: "2024-01-01",
        loginCount: 42,
      });
      expect(user1.is_verified).toBe(false); // New column default

      const user2 = result.rows[1];
      expect(user2.username).toBe("user2");
      expect(user2.settings).toEqual({
        theme: "light",
        notifications: false,
        language: "es",
      });
      expect(user2.tags).toEqual(["user", "beta-tester"]);

      const user3 = result.rows[2];
      expect(user3.username).toBe("user3");
      expect(user3.metadata).toBeNull();
      expect(user3.tags).toEqual(["moderator"]);
    });

    it("should handle large-scale data migration efficiently", async () => {
      await db.execute(sql`
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          event_type TEXT NOT NULL,
          payload JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const eventTypes = ["click", "view", "purchase", "signup", "logout"];
      const batchSize = 100;

      for (let batch = 0; batch < 10; batch++) {
        const values: string[] = [];
        for (let i = 0; i < batchSize; i++) {
          const eventNum = batch * batchSize + i;
          const eventType = eventTypes[eventNum % eventTypes.length];
          values.push(
            `('${eventType}', '{"id": ${eventNum}, "timestamp": "${new Date().toISOString()}"}')`
          );
        }

        await db.execute(
          sql.raw(`
          INSERT INTO events (event_type, payload) 
          VALUES ${values.join(", ")}
        `)
        );
      }

      const initialCount = await db.execute(sql`SELECT COUNT(*) as count FROM events`);
      expect(Number(initialCount.rows[0].count)).toBe(1000);

      const eventsTable = pgTable("events", {
        id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
        event_type: text("event_type").notNull(),
        payload: jsonb("payload"),
        created_at: timestamp("created_at").defaultNow(),
        user_id: uuid("user_id"), // New column
        session_id: text("session_id"), // New column
        processed: boolean("processed").default(false), // New column
      });

      const schema = { events: eventsTable };

      await migrator.migrate("@elizaos/plugin-sql", schema, {
        verbose: false,
        force: true,
      });

      const finalCount = await db.execute(sql`SELECT COUNT(*) as count FROM events`);
      expect(Number(finalCount.rows[0].count)).toBe(1000);

      const sample = await db.execute(sql`
        SELECT * FROM events 
        WHERE id IN (1, 100, 500, 999, 1000)
        ORDER BY id
      `);

      expect(sample.rows).toHaveLength(5);
      for (const row of sample.rows) {
        expect(row.event_type).toBeDefined();
        expect(row.payload).toBeDefined();
        expect(row.created_at).toBeDefined();
        expect(row.processed).toBe(false); // New column default
      }

      const status = await migrator.getStatus("@elizaos/plugin-sql");
      expect(status.hasRun).toBe(true);
      expect(status.lastMigration).toBeDefined();
    });
  });
});
