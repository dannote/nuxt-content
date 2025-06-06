import { stat } from 'node:fs/promises'
import {
  defineNuxtModule,
  createResolver,
  addTemplate,
  addTypeTemplate,
  addImports,
  addServerImports,
  addPlugin,
  hasNuxtModule,
  updateTemplates,
  addComponent,
  installModule,
} from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions as MDCModuleOptions } from '@nuxtjs/mdc'
import { hash } from 'ohash'
import { join } from 'pathe'
import htmlTags from '@nuxtjs/mdc/runtime/parser/utils/html-tags-list'
import { kebabCase, pascalCase } from 'scule'
import defu from 'defu'
import { version } from '../package.json'
import { generateCollectionInsert, generateCollectionTableDefinition } from './utils/collection'
import { componentsManifestTemplate, contentTypesTemplate, fullDatabaseRawDumpTemplate, manifestTemplate, moduleTemplates } from './utils/templates'
import type { ResolvedCollection } from './types/collection'
import type { ModuleOptions } from './types/module'
import { getContentChecksum, logger, watchContents, chunks, watchComponents, startSocketServer } from './utils/dev'
import { loadContentConfig } from './utils/config'
import { createParser } from './utils/content'
import { installMDCModule } from './utils/mdc'
import { findPreset } from './presets'
import type { Manifest } from './types/manifest'
import { setupPreview, shouldEnablePreview } from './utils/preview/module'
import { parseSourceBase } from './utils/source'
import { databaseVersion, getLocalDatabase, refineDatabaseConfig, resolveDatabaseAdapter } from './utils/database'

// Export public utils
export * from './utils'
export type * from './types'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@nuxt/content',
    configKey: 'content',
    version,
    docs: 'https://content.nuxt.com',
  },
  defaults: {
    _localDatabase: {
      type: 'sqlite',
      filename: '.data/content/contents.sqlite',
    },
    preview: {},
    watch: {
      enabled: true,
      port: {
        port: 4000,
        portRange: [4000, 4040],
      },
      hostname: 'localhost',
      showURL: false,
    },
    renderer: {
      alias: {},
      anchorLinks: {
        h2: true,
        h3: true,
        h4: true,
      },
    },
    build: {
      pathMeta: {},
      markdown: {},
      yaml: {},
      csv: {
        delimiter: ',',
        json: true,
      },
    },
    experimental: {
      nativeSqlite: false,
    },
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const manifest: Manifest = {
      checksumStructure: {},
      checksum: {},
      dump: {},
      components: [],
      collections: [],
    }

    const { collections } = await loadContentConfig(nuxt)
    manifest.collections = collections

    nuxt.options.vite.optimizeDeps ||= {}
    nuxt.options.vite.optimizeDeps.exclude ||= []
    nuxt.options.vite.optimizeDeps.exclude.push('@sqlite.org/sqlite-wasm')

    // Ignore content directory files in building
    nuxt.options.ignore = [...(nuxt.options.ignore || []), 'content/**']

    // Helpers are designed to be enviroment agnostic
    addImports([
      { name: 'queryCollection', from: resolver.resolve('./runtime/app') },
      { name: 'queryCollectionSearchSections', from: resolver.resolve('./runtime/app') },
      { name: 'queryCollectionNavigation', from: resolver.resolve('./runtime/app') },
      { name: 'queryCollectionItemSurroundings', from: resolver.resolve('./runtime/app') },
    ])
    addServerImports([
      { name: 'queryCollectionWithEvent', as: 'queryCollection', from: resolver.resolve('./runtime/nitro') },
      { name: 'queryCollectionSearchSectionsWithEvent', as: 'queryCollectionSearchSections', from: resolver.resolve('./runtime/nitro') },
      { name: 'queryCollectionNavigationWithEvent', as: 'queryCollectionNavigation', from: resolver.resolve('./runtime/nitro') },
      { name: 'queryCollectionItemSurroundingsWithEvent', as: 'queryCollectionItemSurroundings', from: resolver.resolve('./runtime/nitro') },
    ])
    addComponent({ name: 'ContentRenderer', filePath: resolver.resolve('./runtime/components/ContentRenderer.vue') })

    // Add Templates & aliases
    nuxt.options.nitro.alias = nuxt.options.nitro.alias || {}
    addTemplate(fullDatabaseRawDumpTemplate(manifest))
    nuxt.options.alias['#content/components'] = addTemplate(componentsManifestTemplate(manifest)).dst
    nuxt.options.alias['#content/manifest'] = addTemplate(manifestTemplate(manifest)).dst

    // Add content types to Nuxt and Nitro
    const typesTemplateDst = addTypeTemplate(contentTypesTemplate(manifest.collections)).dst
    nuxt.options.nitro.typescript ||= {}
    nuxt.options.nitro.typescript.tsConfig = defu(nuxt.options.nitro.typescript.tsConfig, {
      include: [typesTemplateDst],
    })

    // Register user components
    const _layers = [...nuxt.options._layers].reverse()
    for (const layer of _layers) {
      const path = resolver.resolve(layer.config.srcDir, 'components/content')
      const dirStat = await stat(path).catch((): null => null)
      if (dirStat && dirStat.isDirectory()) {
        nuxt.hook('components:dirs', (dirs) => {
          dirs.unshift({ path, pathPrefix: false, prefix: '' })
        })
      }
    }

    // Prerender database.sql routes for each collection to fetch dump
    nuxt.options.routeRules ||= {}

    // @ts-expect-error - Prevent nuxtseo from indexing nuxt-content routes
    // @see https://github.com/nuxt/content/pull/3299
    nuxt.options.routeRules![`/__nuxt_content/**`] = { robots: false }

    manifest.collections.forEach((collection) => {
      if (!collection.private) {
        nuxt.options.routeRules![`/__nuxt_content/${collection.name}/sql_dump.txt`] = { prerender: true }
      }
    })

    const preset = findPreset(nuxt)
    await preset?.setup?.(options, nuxt)

    // Provide default database configuration here since nuxt is merging defaults and user options
    options.database ||= { type: 'sqlite', filename: './contents.sqlite' }
    await refineDatabaseConfig(options._localDatabase, { rootDir: nuxt.options.rootDir, updateSqliteFileName: true })
    await refineDatabaseConfig(options.database, { rootDir: nuxt.options.rootDir })

    // Module Options
    nuxt.options.runtimeConfig.public.content = {
      wsUrl: '',
    }
    nuxt.options.runtimeConfig.content = {
      databaseVersion,
      version,
      database: options.database,
      localDatabase: options._localDatabase!,
      integrityCheck: true,
    } as never

    nuxt.hook('nitro:config', async (config) => {
      const preset = findPreset(nuxt)
      await preset.setupNitro(config, { manifest, resolver, moduleOptions: options })

      const resolveOptions = { resolver, sqliteConnector: options.experimental?.sqliteConnector || (options.experimental?.nativeSqlite ? 'native' : undefined) }
      config.alias ||= {}
      config.alias['#content/adapter'] = await resolveDatabaseAdapter(config.runtimeConfig!.content!.database?.type || options.database.type, resolveOptions)
      config.alias['#content/local-adapter'] = await resolveDatabaseAdapter(options._localDatabase!.type || 'sqlite', resolveOptions)

      config.handlers ||= []
      config.handlers.push({
        route: '/__nuxt_content/:collection/query',
        handler: resolver.resolve('./runtime/api/query.post'),
      })

      // Handle HMR changes
      if (nuxt.options.dev) {
        addPlugin({ src: resolver.resolve('./runtime/plugins/websocket.dev'), mode: 'client' })
        await watchComponents(nuxt)
        const socket = await startSocketServer(nuxt, options, manifest)
        await watchContents(nuxt, options, manifest, socket)
      }
    })

    if (hasNuxtModule('nuxt-llms')) {
      installModule(resolver.resolve('./features/llms'))
    }
    await installMDCModule(options, nuxt)

    if (nuxt.options._prepare) {
      return
    }

    // Generate collections and sql dump to update templates local database
    // `modules:done` is triggered for all environments
    nuxt.hook('modules:done', async () => {
      const fest = await processCollectionItems(nuxt, manifest.collections, options)

      // Update manifest
      manifest.checksumStructure = fest.checksumStructure
      manifest.checksum = fest.checksum
      manifest.dump = fest.dump
      manifest.components = fest.components

      await updateTemplates({
        filter: template => [
          moduleTemplates.fullRawDump,
          moduleTemplates.fullCompressedDump,
          moduleTemplates.manifest,
          moduleTemplates.components,
        ].includes(template.filename),
      })

      // Handle preview mode
      if (shouldEnablePreview(nuxt, options)) {
        await setupPreview(options, nuxt, resolver, manifest)
      }
    })
  },
})

async function processCollectionItems(nuxt: Nuxt, collections: ResolvedCollection[], options: ModuleOptions) {
  const collectionDump: Record<string, string[]> = {}
  const collectionChecksum: Record<string, string> = {}
  const collectionChecksumStructure: Record<string, string> = {}
  const db = await getLocalDatabase(options._localDatabase, {
    sqliteConnector: options.experimental?.sqliteConnector || (options.experimental?.nativeSqlite ? 'native' : undefined),
  })
  const databaseContents = await db.fetchDevelopmentCache()

  const configHash = hash({
    mdcHighlight: (nuxt.options as unknown as { mdc: MDCModuleOptions }).mdc?.highlight,
    contentBuild: options.build?.markdown,
  })

  const infoCollection = collections.find(c => c.name === 'info')!

  const startTime = performance.now()
  let filesCount = 0
  let cachedFilesCount = 0
  let parsedFilesCount = 0

  // Remove all existing content collections to start with a clean state
  db.dropContentTables()
  // Create database dump
  for await (const collection of collections) {
    if (collection.name === 'info') {
      continue
    }
    const collectionHash = hash(collection)
    const collectionQueries = generateCollectionTableDefinition(collection, { drop: true })
      .split('\n').map(q => `${q} -- structure`)

    if (!collection.source) {
      continue
    }

    const parse = await createParser(collection, nuxt)

    const structureVersion = collectionChecksumStructure[collection.name] = hash(collectionQueries)

    for await (const source of collection.source) {
      if (source.prepare) {
        // @ts-expect-error - `__rootDir` is a private property to store the layer's cwd
        const rootDir = collection.__rootDir || nuxt.options.rootDir
        await source.prepare({ rootDir })
      }

      const { fixed } = parseSourceBase(source)
      const cwd = source.cwd
      const _keys = await source.getKeys?.() || []

      filesCount += _keys.length

      /**
       * list is an array of tuples
       * 0: filePath/key
       * 1: queries
       * 2: hash
       */
      const list: Array<[string, Array<string>, string]> = []
      for await (const chunk of chunks(_keys, 25)) {
        await Promise.all(chunk.map(async (key) => {
          const keyInCollection = join(collection.name, source?.prefix || '', key)
          const fullPath = join(cwd, fixed, key)
          const cache = databaseContents[keyInCollection]

          try {
            const content = await source.getItem?.(key) || ''
            const checksum = getContentChecksum(configHash + collectionHash + content)

            let parsedContent
            if (cache && cache.checksum === checksum) {
              cachedFilesCount += 1
              parsedContent = JSON.parse(cache.value)
            }
            else {
              parsedFilesCount += 1
              parsedContent = await parse({
                id: keyInCollection,
                body: content,
                path: fullPath,
              })
              if (parsedContent) {
                db.insertDevelopmentCache(keyInCollection, JSON.stringify(parsedContent), checksum)
              }
            }

            const { queries, hash } = generateCollectionInsert(collection, parsedContent)
            list.push([key, queries, hash])
          }
          catch (e: unknown) {
            logger.warn(`"${keyInCollection}" is ignored because parsing is failed. Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
          }
        }))
      }

      // Sort by file name to ensure consistent order
      list.sort((a, b) => String(a[0]).localeCompare(String(b[0])))

      collectionQueries.push(...list.flatMap(([, sql, hash]) => sql.map(q => `${q} -- ${hash}`)))
    }

    const version = collectionChecksum[collection.name] = `${databaseVersion}--${hash(collectionQueries)}`

    collectionDump[collection.name] = [
      // we have to start the series of queries
      // by telling everyone that we are setting up the collection so no
      // other request start doing the same work and fail
      // so we create a new entry in the info table saying that it is not ready yet
      // NOTE: all queries having the structure comment at the end, will be ignored at init if no
      // structure changes are detected in the structureVersion
      `${generateCollectionTableDefinition(infoCollection, { drop: false })} -- structure`,
      ...generateCollectionInsert(infoCollection, { id: `checksum_${collection.name}`, version, structureVersion, ready: false }).queries.map(row => `${row} -- meta`),

      // Insert queries for the collection
      ...collectionQueries,

      // and finally when we are finished, we update the info table to say that the init is done
      `UPDATE ${infoCollection.tableName} SET ready = true WHERE id = 'checksum_${collection.name}'; -- meta`,
    ]
  }

  const sqlDumpList = Object.values(collectionDump).flatMap(a => a)

  // Drop info table and recreate it
  db.exec(`DROP TABLE IF EXISTS ${infoCollection.tableName}`)
  for (const sql of sqlDumpList) {
    db.exec(sql)
  }

  const tags = sqlDumpList.flatMap((sql: string): RegExpMatchArray | [] => sql.match(/(?<=(^|,|\[)\[")[^"]+(?=")/g) || [])
  const uniqueTags = [
    ...Object.values(options.renderer.alias || {}),
    ...new Set(tags),
  ]
    .map(tag => getMappedTag(tag, options?.renderer?.alias))
    .filter(tag => !htmlTags.includes(kebabCase(tag)))
    .map(tag => pascalCase(tag))

  const endTime = performance.now()
  logger.success(`Processed ${collections.length} collections and ${filesCount} files in ${(endTime - startTime).toFixed(2)}ms (${cachedFilesCount} cached, ${parsedFilesCount} parsed)`)

  return {
    checksumStructure: collectionChecksumStructure,
    checksum: collectionChecksum,
    dump: collectionDump,
    components: uniqueTags,
  }
}

const proseTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'strong', 'em', 's', 'code', 'span', 'blockquote', 'pre', 'hr', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td']
function getMappedTag(tag: string, additionalTags: Record<string, string> = {}) {
  if (proseTags.includes(tag)) {
    return `prose-${tag}`
  }
  return additionalTags[tag] || tag
}
