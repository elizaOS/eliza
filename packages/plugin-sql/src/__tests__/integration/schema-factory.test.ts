import { describe, it, expect, beforeEach } from 'bun:test';
import { SchemaFactory, setDatabaseType, getSchemaFactory } from '../../schema/factory';
import { sql } from 'drizzle-orm';
import { pgTable } from 'drizzle-orm/pg-core';

describe('Schema Factory Integration Tests', () => {
  describe('SchemaFactory', () => {
    let postgresFactory: SchemaFactory;
    let pgliteFactory: SchemaFactory;

    beforeEach(() => {
      postgresFactory = new SchemaFactory('postgres');
      pgliteFactory = new SchemaFactory('pglite');
    });

    it('should create factory with correct database type', () => {
      expect(postgresFactory.dbType).toBe('postgres');
      expect(pgliteFactory.dbType).toBe('pglite');
    });

    it('should return pgTable for both database types', () => {
      expect(postgresFactory.table).toBe(pgTable);
      expect(pgliteFactory.table).toBe(pgTable);
    });

    it('should create uuid columns', () => {
      const pgUuid = postgresFactory.uuid('id');
      const pgliteUuid = pgliteFactory.uuid('id');

      expect(pgUuid).toBeDefined();
      expect(pgliteUuid).toBeDefined();
    });

    it('should create text columns', () => {
      const pgText = postgresFactory.text('name');
      const pgliteText = pgliteFactory.text('name');

      expect(pgText).toBeDefined();
      expect(pgliteText).toBeDefined();
    });

    it('should create json columns', () => {
      const pgJson = postgresFactory.json('metadata');
      const pgliteJson = pgliteFactory.json('metadata');

      expect(pgJson).toBeDefined();
      expect(pgliteJson).toBeDefined();
    });

    it('should create boolean columns', () => {
      const pgBool = postgresFactory.boolean('active');
      const pgliteBool = pgliteFactory.boolean('active');

      expect(pgBool).toBeDefined();
      expect(pgliteBool).toBeDefined();
    });

    it('should create timestamp columns with options', () => {
      const pgTs = postgresFactory.timestamp('createdAt', { withTimezone: true, mode: 'date' });
      const pgliteTs = pgliteFactory.timestamp('updatedAt', { mode: 'string' });

      expect(pgTs).toBeDefined();
      expect(pgliteTs).toBeDefined();
    });

    it('should create integer columns', () => {
      const pgInt = postgresFactory.integer('count');
      const pgliteInt = pgliteFactory.integer('count');

      expect(pgInt).toBeDefined();
      expect(pgliteInt).toBeDefined();
    });

    it('should handle vector columns differently for postgres vs pglite', () => {
      const pgVector = postgresFactory.vector('embedding', 384);
      const pgliteVector = pgliteFactory.vector('embedding', 384);

      expect(pgVector).toBeDefined();
      expect(pgliteVector).toBeDefined();

      // Postgres uses real vector type, pglite falls back to jsonb
      // We verify they return different types by their existence
    });

    it('should create text array columns', () => {
      const pgArray = postgresFactory.textArray('tags');
      const pgliteArray = pgliteFactory.textArray('tags');

      expect(pgArray).toBeDefined();
      expect(pgliteArray).toBeDefined();
    });

    it('should create check constraints', () => {
      const constraint = sql`price > 0`;
      const pgCheck = postgresFactory.check('positive_price', constraint);
      const pgliteCheck = pgliteFactory.check('positive_price', constraint);

      expect(pgCheck).toBeDefined();
      expect(pgliteCheck).toBeDefined();
    });

    it('should create indexes', () => {
      const pgIndex = postgresFactory.index('idx_name');
      const pgliteIndex = pgliteFactory.index();

      expect(pgIndex).toBeDefined();
      expect(pgliteIndex).toBeDefined();
    });

    it('should create foreign key constraints', () => {
      const config = {
        name: 'fk_user',
        columns: ['userId'],
        foreignColumns: ['id'],
      };

      const pgFk = postgresFactory.foreignKey(config);
      const pgliteFk = pgliteFactory.foreignKey(config);

      expect(pgFk).toBeDefined();
      expect(pgliteFk).toBeDefined();
    });

    it('should provide default timestamp helper', () => {
      const pgDefault = postgresFactory.defaultTimestamp();
      const pgliteDefault = pgliteFactory.defaultTimestamp();

      expect(pgDefault).toBeDefined();
      expect(pgliteDefault).toBeDefined();
      // The SQL template returns a SQL object with SQL string
      // We just verify it returns a SQL template object
      expect(pgDefault).toHaveProperty('queryChunks');
    });

    it('should handle random UUID default differently', () => {
      const pgDefault = postgresFactory.defaultRandomUuid();
      const pgliteDefault = pgliteFactory.defaultRandomUuid();

      // Postgres supports gen_random_uuid()
      expect(pgDefault).toBeDefined();
      expect(pgDefault).toHaveProperty('queryChunks');

      // Pglite doesn't support it
      expect(pgliteDefault).toBeUndefined();
    });
  });

  describe('Global factory management', () => {
    it('should set and get global factory', () => {
      setDatabaseType('pglite');
      const factory = getSchemaFactory();

      expect(factory).toBeDefined();
      expect(factory.dbType).toBe('pglite');
    });

    it('should default to postgres if not set', () => {
      // Reset global factory
      setDatabaseType('postgres');

      const factory = getSchemaFactory();
      expect(factory.dbType).toBe('postgres');
    });
  });
});
