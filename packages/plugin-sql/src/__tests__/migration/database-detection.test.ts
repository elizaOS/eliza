import { describe, it, expect } from 'bun:test';
import { RuntimeMigrator } from '../../runtime-migrator';

/**
 * Unit tests for the isRealPostgresDatabase method
 * Testing the improved database detection logic that handles various PostgreSQL connection formats
 */
describe('RuntimeMigrator - Database Detection', () => {
  // Create a test helper to access the private method
  // Since isRealPostgresDatabase is private, we'll test it through a minimal wrapper
  class TestRuntimeMigrator extends RuntimeMigrator {
    constructor() {
      // Pass a dummy db object since we're only testing the detection logic
      super({} as any);
    }

    // Expose the private method for testing
    public testIsRealPostgresDatabase(url: string): boolean {
      return (this as any).isRealPostgresDatabase(url);
    }
  }

  const migrator = new TestRuntimeMigrator();

  describe('Valid PostgreSQL Connection Strings', () => {
    it('should detect standard postgres:// URLs', () => {
      const urls = [
        'postgres://user:password@localhost:5432/mydb',
        'postgres://user@localhost/mydb',
        'postgres://localhost/mydb',
        'POSTGRES://USER:PASSWORD@HOST:5432/DB', // Case insensitive
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should detect standard postgresql:// URLs', () => {
      const urls = [
        'postgresql://user:password@localhost:5432/mydb',
        'postgresql://user@localhost/mydb',
        'postgresql://localhost/mydb',
        'POSTGRESQL://USER:PASSWORD@HOST:5432/DB', // Case insensitive
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should detect cloud provider PostgreSQL URLs', () => {
      const urls = [
        // AWS RDS
        'postgresql://user:pass@myinstance.123456789012.us-east-1.rds.amazonaws.com:5432/mydb',
        'postgres://user:pass@mydb.cluster-abc123.us-west-2.rds.amazonaws.com:5432/prod',

        // Azure Database for PostgreSQL
        'postgresql://user@myserver:password@myserver.postgres.database.azure.com:5432/mydb?sslmode=require',

        // Google Cloud SQL
        'postgresql://user:password@127.0.0.1:5432/mydb?host=/cloudsql/project:region:instance',
        'postgres://user@35.201.123.45:5432/production?application_name=myapp',

        // Supabase
        'postgresql://postgres.abcdefghijklmnop:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres',
        'postgres://user:pass@db.abcdefghijklmnop.supabase.co:5432/postgres',

        // Neon
        'postgresql://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require',
        'postgres://user:pass@ep-name-123456.eu-central-1.aws.neon.tech/dbname',

        // DigitalOcean Managed Database
        'postgresql://doadmin:password@db-postgresql-nyc1-12345-do-user-123456-0.db.ondigitalocean.com:25060/defaultdb?sslmode=require',

        // Aiven
        'postgres://avnadmin:password@pg-123456-project.aivencloud.com:12345/defaultdb?sslmode=require',
        'postgresql://user:pass@my-pg-project-name.aiven.io:21234/mydb',

        // TimescaleDB Cloud
        'postgresql://tsdbadmin:password@abcdef123.a.timescaledb.io:31234/tsdb?sslmode=require',
        'postgres://user:pass@service.region.timescale.com:30000/tsdb',

        // CockroachDB (PostgreSQL-compatible)
        'postgresql://user:pass@free-tier.gcp-us-central1.cockroachlabs.cloud:26257/defaultdb?sslmode=require',
        'postgres://user@app-name-1234.cockroachlabs.cloud:26257/mydb',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should detect PostgreSQL URLs with special parameters', () => {
      const urls = [
        'postgres://user:pass@localhost:5432/mydb?sslmode=require',
        'postgresql://user:pass@localhost:5432/mydb?sslmode=require&connect_timeout=10',
        'postgres://user:pass@localhost:5432/mydb?application_name=myapp',
        'postgresql://user:pass@localhost:5432/mydb?sslmode=require&sslcert=client.crt&sslkey=client.key',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should detect host:port/database format without scheme', () => {
      const urls = [
        'localhost:5432/mydb',
        '192.168.1.1:5432/testdb',
        'db.example.com:5432/production',
        'postgres-server.local:5433/app_db',
        '10.0.0.50:5432/my_database',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should detect PostgreSQL connection string parameters', () => {
      const urls = [
        'host=localhost port=5432 dbname=mydb user=myuser password=mypass',
        'host=db.example.com port=5432 dbname=production sslmode=require',
        'host=192.168.1.1 dbname=testdb user=admin',
        'dbname=mydb host=localhost',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should detect alternative PostgreSQL ports', () => {
      const urls = [
        'postgres://localhost:5433/mydb',
        'postgresql://host:6543/database',
        'postgres://server:15432/db',
        'localhost:5433/mydb',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });
  });

  describe('Invalid/Non-PostgreSQL Connection Strings', () => {
    it('should reject PGLite connection strings', () => {
      const urls = [
        'pglite://localhost/mydb',
        '/path/to/pglite/database',
        './pglite/data',
        '/home/user/pglite/db',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should reject in-memory database strings', () => {
      const urls = [
        ':memory:',
        'sqlite::memory:',
        'postgres://:memory:',
        'postgresql://localhost:5432/:memory:',
        'file::memory:?cache=shared',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should reject SQLite connection strings', () => {
      const urls = [
        'sqlite:///path/to/database.db',
        'sqlite3:///home/user/data.db',
        '/path/to/database.sqlite',
        './data/app.db',
        'database.db',
        'myapp.sqlite',
        'data.sqlite3',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should reject file-based database paths', () => {
      const urls = [
        '/absolute/path/to/data.db',
        './relative/path/to/data.sqlite',
        '../parent/database.db',
        'database.db',
        'local.sqlite3',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should reject empty or invalid strings', () => {
      const urls = ['', ' ', '   ', '\n', '\t'];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should reject MySQL connection strings', () => {
      const urls = [
        'mysql://user:password@localhost:3306/mydb',
        'mysql://localhost/database',
        'mysqli://user@host/db',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should reject MongoDB connection strings', () => {
      const urls = [
        'mongodb://localhost:27017/mydb',
        'mongodb+srv://user:pass@cluster.mongodb.net/db',
        'mongodb://user:password@host1:27017,host2:27017/database',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle URLs with special characters in credentials', () => {
      const urls = [
        'postgres://user%40example:p%40ssw0rd@localhost:5432/mydb', // @ symbol encoded
        'postgresql://user:p@$$w0rd!@localhost:5432/mydb',
        'postgres://user\\with\\backslash:pass@localhost/db',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should handle URLs with unusual database names', () => {
      const urls = [
        'postgres://localhost:5432/my-db-name',
        'postgresql://localhost:5432/my_db_name_123',
        'postgres://localhost:5432/DB',
        'localhost:5432/test-db_2024',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should handle URLs with IPv6 addresses', () => {
      const urls = [
        'postgres://[::1]:5432/mydb',
        'postgresql://user:pass@[2001:db8::1]:5432/database',
        'postgres://[fe80::1%lo0]:5432/localdb',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should be case-insensitive for detection', () => {
      const urls = [
        'POSTGRES://LOCALHOST:5432/MYDB',
        'PostgreSQL://Host:5432/Database',
        'postgres://SUPABASE.com/db',
        'POSTGRESQL://NEON.TECH/database',
        'HOST=localhost DBNAME=mydb',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });

    it('should handle whitespace appropriately', () => {
      // URLs with leading/trailing whitespace
      expect(migrator.testIsRealPostgresDatabase('  postgres://localhost:5432/mydb  ')).toBe(true);
      expect(migrator.testIsRealPostgresDatabase('\tpostgresql://localhost/db\n')).toBe(true);
      expect(migrator.testIsRealPostgresDatabase('  localhost:5432/mydb  ')).toBe(true);

      // But reject truly empty strings
      expect(migrator.testIsRealPostgresDatabase('   ')).toBe(false);
    });
  });

  describe('Security Considerations', () => {
    it('should not be fooled by PostgreSQL keywords in non-PostgreSQL URLs', () => {
      // These contain PostgreSQL keywords but are not real PostgreSQL databases
      const urls = [
        'sqlite:///path/with/postgres/in/it.db',
        'mongodb://postgres.example.com:27017/db', // MongoDB on a host named postgres
        'file:///data/postgresql/backup.sqlite',
        ':memory:?name=postgres',
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(false);
      }
    });

    it('should correctly identify PostgreSQL even with confusing paths', () => {
      // These are real PostgreSQL despite having potentially confusing elements
      const urls = [
        'postgres://user:pass@localhost:5432/sqlite_migration', // DB named after sqlite
        'postgresql://localhost:5432/memory_cache', // DB with "memory" in name
        'postgres://localhost:5432/file_storage', // DB with "file" in name
      ];

      for (const url of urls) {
        expect(migrator.testIsRealPostgresDatabase(url)).toBe(true);
      }
    });
  });
});
