import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { setup, $fetch } from '@nuxt/test-utils'
import type { Nuxt } from '@nuxt/schema'
import { afterAll, describe, expect, test } from 'vitest'
import { loadContentConfig } from '../src/utils/config'
import { decompressSQLDump } from '../src/runtime/internal/dump'
import { getTableName } from '../src/utils/collection'
import { getLocalDatabase } from '../src/utils/database'
import type { LocalDevelopmentDatabase } from '../src/module'

async function cleanup() {
  await fs.rm(fileURLToPath(new URL('./fixtures/empty/node_modules', import.meta.url)), { recursive: true, force: true })
  await fs.rm(fileURLToPath(new URL('./fixtures/empty/.nuxt', import.meta.url)), { recursive: true, force: true })
  await fs.rm(fileURLToPath(new URL('./fixtures/empty/.data', import.meta.url)), { recursive: true, force: true })
  await fs.rm(fileURLToPath(new URL('./fixtures/empty/content', import.meta.url)), { recursive: true, force: true })
  await fs.rm(fileURLToPath(new URL('./fixtures/empty/content.config.ts', import.meta.url))).catch(() => {})
}

describe('empty', async () => {
  await cleanup()
  afterAll(async () => {
    await cleanup()
  })

  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/empty', import.meta.url)),
    dev: true,
  })

  describe('`content.config.ts`', async () => {
    test('is missing', async () => {
      const stat = await fs.stat(fileURLToPath(new URL('./fixtures/empty/content.config.ts', import.meta.url))).catch(() => null)
      expect(stat?.isFile()).not.toBe(true)
    })
    test('Default collection is defined', async () => {
      const rootDir = fileURLToPath(new URL('./fixtures/empty', import.meta.url))
      const config = await loadContentConfig({ options: { _layers: [{ config: { rootDir } }] } } as Nuxt)

      // Pages collection + info collection
      expect(config.collections.length).toBe(2)
      expect(config.collections.map(c => c.name)).toContain('content')

      const pagesCollection = config.collections.find(c => c.name === 'content')
      expect(pagesCollection).toBeDefined()
      expect(pagesCollection?.type).toBe('page')
      expect(pagesCollection?.source).toBeDefined()
      expect(pagesCollection?.source?.[0]).toBeDefined()
      expect(pagesCollection?.source?.[0].include).toBe('**/*')
    })
  })

  describe('Local database', () => {
    let db: LocalDevelopmentDatabase
    afterAll(async () => {
      if (db) {
        await db.close()
      }
    })
    test('is created', async () => {
      const stat = await fs.stat(fileURLToPath(new URL('./fixtures/empty/.data/content/contents.sqlite', import.meta.url)))
      expect(stat?.isFile()).toBe(true)
    })

    test('load database', async () => {
      db = await getLocalDatabase({ type: 'sqlite', filename: fileURLToPath(new URL('./fixtures/empty/.data/content/contents.sqlite', import.meta.url)) }, { nativeSqlite: true })
    })

    test('content table is created', async () => {
      const cache = await db.database?.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?;`)
        .all(getTableName('content')) as { name: string }[]

      expect(cache).toBeDefined()
      expect(cache).toHaveLength(1)
      expect(cache![0]!.name).toBe(getTableName('content'))
    })
  })

  describe('SQL dump', () => {
    test('is generated', async () => {
      const dump = await import(new URL('./fixtures/empty/.nuxt/content/database.compressed.mjs', import.meta.url).pathname).then(m => m.content)

      const parsedDump = await decompressSQLDump(dump)

      expect(parsedDump.filter(item => item.startsWith('CREATE TABLE IF NOT EXISTS'))).toHaveLength(2)
      // Only info collection is inserted
      expect(parsedDump.filter(item => item.includes('INSERT INTO'))).toHaveLength(1)
    })

    test('is downloadable', async () => {
      const response: string = await $fetch('/__nuxt_content/content/sql_dump.txt', { responseType: 'text' })
      expect(response).toBeDefined()

      const parsedDump = await decompressSQLDump(response as string)

      expect(parsedDump.filter(item => item.startsWith('CREATE TABLE IF NOT EXISTS'))).toHaveLength(2)
      // Only info collection is inserted
      expect(parsedDump.filter(item => item.includes('INSERT INTO'))).toHaveLength(1)
    })
  })
})
