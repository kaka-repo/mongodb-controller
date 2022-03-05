/* eslint-disable @typescript-eslint/method-signature-style */
import EventEmitter from '@kakang/eventemitter'
import AggregateBuilder, { MatchPipeline, SortPipeline } from '@kakang/mongodb-aggregate-builder'
import { isEmpty, isExist, isObject, isString } from '@kakang/validator'
import { BulkWriteOptions, Collection, CreateIndexesOptions, DeleteOptions, Document, Filter, FindOptions, IndexSpecification, InsertOneOptions, OptionalUnlessRequiredId, UpdateFilter, UpdateOptions } from 'mongodb'
import { P } from 'pino'
import { kCreateIndex, kPrivate } from '../symbols'
import { appendBasicSchema, appendUpdateSchema } from '../utils/append'
import { createLogger } from '../utils/logger'
import { noop } from '../utils/noop'
import { findNextPair, isUpdateQuery, normalize, transformRegExpSearch } from '../utils/query'

export interface ControllerOptions {
  logger: P.LoggerOptions | P.BaseLogger
  skipIndex: true
  autoRegExpSearch: boolean
  searchFields: string[]
  postMatchKeywords: string[]
  indexes: Array<{ indexSpec: IndexSpecification, options?: CreateIndexesOptions }>
}

interface Private<TSchema> {
  collection: Collection<TSchema>
  logger: P.BaseLogger
  indexes: Array<{ indexSpec: IndexSpecification, options?: CreateIndexesOptions }>
}

export class Controller<TSchema extends Document = Document> extends EventEmitter {
  private [kPrivate]: Private<TSchema>
  autoRegExpSearch: boolean
  searchFields: string[]
  // used to check if we should append before aggregation
  // it is useful to reduce to time of heavy computation when
  // using aggregation
  postMatchKeywords: string[]

  get collection (): Collection<TSchema> {
    return this[kPrivate].collection
  }

  set collection (collection: Collection<TSchema> | undefined) {
    if (isEmpty(collection)) throw new Error('collection expected to be an object, but recieved "' + typeof collection + '"')
    this[kPrivate].collection = collection
  }

  get collectionName (): string {
    return this[kPrivate].collection.collectionName
  }

  get logger (): P.BaseLogger {
    return this[kPrivate].logger
  }

  constructor (collection?: Collection<any>, options?: Partial<ControllerOptions>) {
    if (isEmpty(collection)) throw new Error('collection expected to be an object, but recieved "' + typeof collection + '"')
    super()
    // initialize private
    this[kPrivate] = {
      collection: null,
      logger: null,
      indexes: [{ indexSpec: { id: 1 }, options: { unique: true } }]
    } as any
    this.collection = collection
    this[kPrivate].logger = createLogger(this.collectionName, options?.logger)
    this[kPrivate].indexes.push(...(options?.indexes ?? []))
    this.autoRegExpSearch = options?.autoRegExpSearch ?? true
    this.searchFields = options?.searchFields ?? []
    this.postMatchKeywords = options?.postMatchKeywords ?? []
    if (options?.skipIndex !== true) this[kCreateIndex]()
    this.emit('initialized').finally(noop)
    this.logger.debug({ func: 'constructor', meta: { options } }, 'created')
  }

  /**
   * Index
   */
  [kCreateIndex] (): void {
    this.logger.debug({ func: 'Symbol("createIndex")', meta: { indexes: this[kPrivate].indexes } }, 'started')
    // we do not wait for index creation
    for (const index of this[kPrivate].indexes) {
      this.collection.createIndex(index.indexSpec, index.options ?? {}, noop)
      this.logger.trace({ func: 'Symbol("createIndex")', meta: { index } }, 'index %j is created', index.indexSpec)
    }
    this.logger.debug({ func: 'Symbol("createIndex")', meta: { indexes: this[kPrivate].indexes } }, 'ended')
  }

  async count (search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>): Promise<number> {
    this.logger.debug({ func: 'count', meta: { search, filter } }, 'started')
    await this.emit('pre-count', search, filter)
    const found = await this.search(search, filter)
    const result = found.length
    await this.emit('post-count', result, search, filter)
    this.logger.debug({ func: 'count', meta: { search, filter } }, 'ended')
    return result
  }

  async search<U = TSchema> (search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>, sort?: string, page?: number, pageSize?: number): Promise<U[]> {
    this.logger.debug({ func: 'search', meta: { search, filter, sort, page, pageSize } }, 'started')
    await this.emit('pre-search', search, filter, sort, page, pageSize)
    const pipeline = this.computePipeline(search, filter, sort, page, pageSize).toArray()
    const result = await this.collection.aggregate<U>(pipeline).toArray()
    await this.emit('post-search', result, search, filter, sort, page, pageSize)
    this.logger.debug({ func: 'search', meta: { search, filter, sort, page, pageSize } }, 'ended')
    return result
  }

  async insertOne (docs: TSchema, options?: InsertOneOptions): Promise<TSchema | null> {
    this.logger.debug({ func: 'insertOne', meta: { docs, options } }, 'started')
    // single end-point for insert validation
    await this.emit('pre-insert', docs)
    const doc = appendBasicSchema(docs)
    await this.emit('pre-insert-one', doc, options)
    await this.collection.insertOne(doc as OptionalUnlessRequiredId<TSchema>, options as InsertOneOptions)
    const result = await this.collection.findOne<TSchema>({ id: doc.id })
    await this.emit('post-insert-one', result, doc, options)
    // single end-point for insert, we do not allow to update result on this end-point
    await this.emit('post-insert')
    this.logger.debug({ func: 'insertOne', meta: { docs, options } }, 'ended')
    return result
  }

  async insertMany (docs: TSchema[], options?: BulkWriteOptions): Promise<TSchema[]> {
    this.logger.debug({ func: 'insertMany', meta: { docs, options } }, 'started')
    // single end-point for insert validation
    await this.emit('pre-insert', docs)
    const doc = appendBasicSchema(docs)
    await this.emit('pre-insert-many', doc, options)
    await this.collection.insertMany(doc as Array<OptionalUnlessRequiredId<TSchema>>, options as BulkWriteOptions)
    const result = await this.collection.find<TSchema>({ id: { $in: doc.map((d) => d.id) } }, { sort: { createdAt: 1 } }).toArray()
    await this.emit('post-insert-many', result, doc, options)
    // single end-point for insert, we do not allow to update result on this end-point
    await this.emit('post-insert')
    this.logger.debug({ func: 'insertMany', meta: { docs, options } }, 'ended')
    return result
  }

  async find (filter?: Filter<TSchema>, options?: FindOptions<TSchema>): Promise<TSchema[]> {
    this.logger.debug({ func: 'find', meta: { filter, options } }, 'started')
    filter = filter ?? {}
    await this.emit('pre-find', filter, options)
    const result = await this.collection.find(filter, options as FindOptions<TSchema>).toArray()
    await this.emit('post-find', result, filter, options)
    this.logger.debug({ func: 'find', meta: { filter, options } }, 'ended')
    return result as unknown as TSchema[]
  }

  async findOne (filter?: Filter<TSchema>, options?: FindOptions<TSchema>): Promise<TSchema | null> {
    this.logger.debug({ func: 'findOne', meta: { filter, options } }, 'started')
    filter = filter ?? {}
    await this.emit('pre-find-one', filter, options)
    const result = await this.collection.findOne(filter, options)
    await this.emit('post-find-one', result, filter, options)
    this.logger.debug({ func: 'findOne', meta: { filter, options } }, 'ended')
    return result
  }

  async findById (id: string, options?: FindOptions<TSchema>): Promise<TSchema | null> {
    this.logger.debug({ func: 'findById', meta: { id, options } }, 'started')
    await this.emit('pre-find-by-id', id, options)
    const filter: Filter<TSchema> = { id } as unknown as Filter<TSchema>
    const result = await this.collection.findOne(filter, options)
    await this.emit('post-find-by-id', result, id, options)
    this.logger.debug({ func: 'findById', meta: { id, options } }, 'ended')
    return result
  }

  async updateOne (filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions): Promise<TSchema | null> {
    this.logger.debug({ func: 'updateOne', meta: { filter, docs, options } }, 'started')
    // single end-point for update validation
    await this.emit('pre-update', filter, docs)
    const doc = appendUpdateSchema(docs)
    await this.emit('pre-update-one', filter, doc, options)
    const o = await this.collection.findOne(filter)
    if (isUpdateQuery(doc)) {
      await this.collection.updateOne(filter, doc, options as UpdateOptions)
    } else {
      await this.collection.updateOne(filter, { $set: doc }, options as UpdateOptions)
    }
    const result = await this.collection.findOne({ id: o?.id })
    await this.emit('post-update-one', result, filter, doc, options)
    // single end-point for update, we do not allow to update result on this end-point
    await this.emit('post-update')
    this.logger.debug({ func: 'updateOne', meta: { filter, docs, options } }, 'ended')
    return result as TSchema
  }

  async updateMany (filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions): Promise<TSchema[]> {
    this.logger.debug({ func: 'updateMany', meta: { filter, docs, options } }, 'started')
    // single end-point for update validation
    await this.emit('pre-update', filter, docs)
    const doc = appendUpdateSchema(docs)
    await this.emit('pre-update-many', filter, doc, options)
    const o = await this.collection.find(filter).toArray()
    if (isUpdateQuery(doc)) {
      await this.collection.updateMany(filter, doc, options as UpdateOptions)
    } else {
      await this.collection.updateMany(filter, { $set: doc }, options as UpdateOptions)
    }
    const result = await this.collection.find({ id: { $in: o.map((o) => o.id) } }).toArray()
    await this.emit('post-update-many', result, filter, doc, options)
    // single end-point for update, we do not allow to update result on this end-point
    await this.emit('post-update')
    this.logger.debug({ func: 'updateMany', meta: { filter, docs, options } }, 'ended')
    return result as unknown as TSchema[]
  }

  async updateById (id: string, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions): Promise<TSchema | null> {
    this.logger.debug({ func: 'updateById', meta: { id, docs, options } }, 'started')
    // single end-point for update validation
    await this.emit('pre-update', { id }, docs)
    const doc = appendUpdateSchema(docs)
    await this.emit('pre-update-by-id', id, doc, options)
    const filter: Filter<TSchema> = { id } as unknown as Filter<TSchema>
    if (isUpdateQuery(doc)) {
      await this.collection.updateOne(filter, doc, options as UpdateOptions)
    } else {
      await this.collection.updateOne(filter, { $set: doc }, options as UpdateOptions)
    }
    const result = await this.collection.findOne(filter, options)
    await this.emit('post-update-by-id', result, id, doc, options)
    // single end-point for update, we do not allow to update result on this end-point
    await this.emit('post-update')
    this.logger.debug({ func: 'updateById', meta: { id, docs, options } }, 'ended')
    return result as unknown as TSchema
  }

  async deleteOne (filter: Filter<TSchema>, options?: DeleteOptions): Promise<TSchema | null> {
    this.logger.debug({ func: 'deleteOne', meta: { filter, options } }, 'started')
    // single end-point for delete validation
    await this.emit('pre-delete', filter)
    const result = await this.collection.findOne(filter)
    await this.emit('pre-delete-one', filter, options)
    await this.collection.deleteOne(filter, options as DeleteOptions)
    await this.emit('post-delete-one', result, filter, options)
    // single end-point for delete, we do not allow to update result on this end-point
    await this.emit('post-delete')
    this.logger.debug({ func: 'deleteOne', meta: { filter, options } }, 'ended')
    return result as TSchema
  }

  async deleteMany (filter?: Filter<TSchema>, options?: DeleteOptions): Promise<TSchema[]> {
    this.logger.debug({ func: 'deleteMany', meta: { filter, options } }, 'started')
    // single end-point for delete validation
    await this.emit('pre-delete', filter)
    filter = filter ?? {}
    const result = await this.collection.find(filter).toArray()
    await this.emit('pre-delete-many', filter, options)
    await this.collection.deleteMany(filter, options as DeleteOptions)
    await this.emit('post-delete-many', result, filter, options)
    // single end-point for delete, we do not allow to update result on this end-point
    await this.emit('post-delete')
    this.logger.debug({ func: 'deleteMany', meta: { filter, options } }, 'ended')
    return result as unknown as TSchema[]
  }

  async deleteById (id: string, options?: DeleteOptions): Promise<TSchema | null> {
    this.logger.debug({ func: 'deleteById', meta: { id, options } }, 'started')
    // single end-point for delete validation
    await this.emit('pre-delete', { id })
    const filter: Filter<TSchema> = { id } as unknown as Filter<TSchema>
    const result = await this.collection.findOne<TSchema>(filter, options)
    await this.emit('pre-delete-by-id', id, options)
    await this.collection.deleteOne(filter, options as DeleteOptions)
    await this.emit('post-delete-by-id', result, id, options)
    // single end-point for delete, we do not allow to update result on this end-point
    await this.emit('post-delete')
    this.logger.debug({ func: 'deleteById', meta: { id, options } }, 'ended')
    return result
  }

  // search is always pre-query
  // we filter first then reduce the area of aggregate
  computePreQuery (search?: any, filter?: any, ..._args: any[]): AggregateBuilder {
    this.logger.trace({ func: 'computePreQuery', meta: { search, filter, args: _args } }, 'started')
    const opt: MatchPipeline = {}
    const arr: any[] = []
    const builder = new AggregateBuilder()
    if ((isString(search) || isObject(search)) && isExist(search) && (this.searchFields.length > 0)) {
      if (this.autoRegExpSearch) { search = transformRegExpSearch(search as any) }
      const sub: any[] = []
      this.searchFields.forEach(function (field) {
        sub.push({ [field]: normalize(search) })
      })
      arr.push({ $or: sub })
    }

    if (typeof filter === 'string') {
      if (!filter.endsWith(',')) filter += ','
      for (let i = 0; i <= filter.length; i++) {
        const { endIndex, key, value } = findNextPair(filter, i)
        if (key === '' && value === '') break
        let shouldAdd = true
        for (let j = 0; j < this.postMatchKeywords.length; j++) {
          if (!shouldAdd) break
          if (key.includes(this.postMatchKeywords[j])) shouldAdd = false
        }
        if (shouldAdd) arr.push({ [key]: normalize(value) })
        i = endIndex - 1
      }
    }

    if (arr.length > 0) opt.$and = arr
    builder.match(opt)
    this.logger.trace({ func: 'computePreQuery', meta: { search, filter, args: _args } }, 'ended')
    return builder
  }

  // search is always pre-query
  // we filter first then reduce the area of aggregate
  computePostQuery (filter?: any, ..._args: any[]): AggregateBuilder | false {
    this.logger.trace({ func: 'computePostQuery', meta: { filter, args: _args } }, 'started')
    const opt: MatchPipeline = {}
    const arr: any[] = []
    const builder = new AggregateBuilder()
    if (typeof filter === 'string') {
      if (!filter.endsWith(',')) filter += ','
      for (let i = 0; i <= filter.length; i++) {
        const { endIndex, key, value } = findNextPair(filter, i)
        if (key === '' && value === '') break
        let shouldAdd = false
        for (let j = 0; j < this.postMatchKeywords.length; j++) {
          if (shouldAdd) break
          if (key.includes(this.postMatchKeywords[j])) shouldAdd = true
        }
        if (shouldAdd) arr.push({ [key]: normalize(value) })
        i = endIndex - 1
      }
    }

    if (arr.length > 0) opt.$and = arr
    else return false
    builder.match(opt)
    this.logger.trace({ func: 'computePostQuery', meta: { filter, args: _args } }, 'ended')
    return builder
  }

  computeSort (sort?: string): AggregateBuilder | false {
    this.logger.trace({ func: 'computeSort', meta: { sort } }, 'started')
    if (typeof sort === 'string') {
      const opt: SortPipeline = {}
      const builder = new AggregateBuilder()
      sort.split(',').forEach(function (o) {
        const orderKey = o.startsWith('-') ? '-' : '+'
        const key = o.replace(orderKey, '').trim()
        const order = orderKey === '-' ? -1 : 1
        // prevent empty key
        if (isExist(key)) opt[key] = order
      })
      builder.sort(opt)
      this.logger.trace({ func: 'computeSort', meta: { sort } }, 'ended')
      return builder
    } else {
      this.logger.trace({ func: 'computeSort', meta: { sort } }, 'ended')
      return false
    }
  }

  computeOption (page?: number, pageSize?: number): AggregateBuilder | false {
    this.logger.trace({ func: 'computeOption', meta: { page, pageSize } }, 'started')
    if (typeof page !== 'undefined' && typeof pageSize !== 'undefined') {
      const builder = new AggregateBuilder()
      const skip = page > 0 ? (page - 1) * pageSize : 0
      builder.limit(pageSize + skip)
      builder.skip(skip)
      this.logger.trace({ func: 'computeOption', meta: { page, pageSize } }, 'ended')
      return builder
    } else {
      this.logger.trace({ func: 'computeOption', meta: { page, pageSize } }, 'ended')
      return false
    }
  }

  computePipeline (search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>, sort?: string, page?: number, pageSize?: number): AggregateBuilder {
    this.logger.trace({ func: 'computePipeline', meta: { search, filter, sort, page, pageSize } }, 'started')
    const builder = this.computePreQuery(search, filter)
    builder.concat(this.buildAggregateBuilder())
    const s = this.computeSort(sort)
    if (s !== false) builder.concat(s)
    const p = this.computeOption(page, pageSize)
    if (p !== false) builder.concat(p)
    const q = this.computePostQuery(filter)
    if (q !== false) builder.concat(q)
    this.logger.trace({ func: 'computePipeline', meta: { search, filter, sort, page, pageSize } }, 'ended')
    return builder
  }

  buildAggregateBuilder (..._args: any[]): AggregateBuilder {
    return new AggregateBuilder()
  }

  async resetDatabase (): Promise<boolean> {
    this.logger.trace({ func: 'resetDatabase' }, 'started')
    await this.emit('pre-reset')
    await this.collection.drop()
    await this[kCreateIndex]()
    await this.emit('post-reset')
    this.logger.trace({ func: 'resetDatabase' }, 'ended')
    return true
  }
}

export interface Controller<TSchema extends Document = Document> extends EventEmitter {
  on (eventName: 'initialized', listener: () => void | Promise<void>): this
  on (eventName: 'pre-count', listener: (search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>) => void | Promise<void>): this
  on (eventName: 'post-count', listener: (result: number, search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>) => void | Promise<void>): this
  on (eventName: 'pre-search', listener: (search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>, sort?: string, page?: number, pageSize?: number) => void | Promise<void>): this
  on (eventName: 'post-search', listener: <U = TSchema>(result: U[], search?: string | Record<string, unknown>, filter?: string | Record<string, unknown>, sort?: string, page?: number, pageSize?: number) => void | Promise<void>): this
  on (eventName: 'pre-insert', listener: (docs: TSchema | TSchema[]) => void | Promise<void>): this
  on (eventName: 'pre-insert-one', listener: (docs: TSchema, options?: InsertOneOptions) => void | Promise<void>): this
  on (eventName: 'post-insert-one', listener: (result: TSchema | null, docs: TSchema, options?: InsertOneOptions) => void | Promise<void>): this
  on (eventName: 'pre-insert-many', listener: (docs: TSchema[], options?: BulkWriteOptions) => void | Promise<void>): this
  on (eventName: 'post-insert-many', listener: (result: TSchema[], docs: TSchema[], options?: BulkWriteOptions) => void | Promise<void>): this
  on (eventName: 'post-insert', listener: () => void | Promise<void>): this
  on (eventName: 'pre-find', listener: (filter?: Filter<TSchema>, options?: FindOptions<TSchema>) => void | Promise<void>): this
  on (eventName: 'post-find', listener: (result: TSchema[], filter?: Filter<TSchema>, options?: FindOptions<TSchema>) => void | Promise<void>): this
  on (eventName: 'pre-find-one', listener: (filter?: Filter<TSchema>, options?: FindOptions<TSchema>) => void | Promise<void>): this
  on (eventName: 'post-find-one', listener: (result: TSchema | null, filter?: Filter<TSchema>, options?: FindOptions<TSchema>) => void | Promise<void>): this
  on (eventName: 'pre-find-by-id', listener: (id: string, options?: FindOptions<TSchema>) => void | Promise<void>): this
  on (eventName: 'post-find-by-id', listener: (result: TSchema | null, id: string, options?: FindOptions<TSchema>) => void | Promise<void>): this
  on (eventName: 'pre-update', listener: (filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>) => void | Promise<void>): this
  on (eventName: 'pre-update-one', listener: (filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions) => void | Promise<void>): this
  on (eventName: 'post-update-one', listener: (result: TSchema | null, filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions) => void | Promise<void>): this
  on (eventName: 'pre-update-many', listener: (filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions) => void | Promise<void>): this
  on (eventName: 'post-update-many', listener: (result: TSchema[], filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions) => void | Promise<void>): this
  on (eventName: 'pre-update-by-id', listener: (id: string, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions) => void | Promise<void>): this
  on (eventName: 'post-update-by-id', listener: (result: TSchema | null, id: string, docs: UpdateFilter<TSchema> | Partial<TSchema>, options?: UpdateOptions) => void | Promise<void>): this
  on (eventName: 'post-update', listener: () => void | Promise<void>): this
  on (eventName: 'pre-delete', listener: (filter: Filter<TSchema>, docs: UpdateFilter<TSchema> | Partial<TSchema>) => void | Promise<void>): this
  on (eventName: 'pre-delete-one', listener: (filter: Filter<TSchema>, options?: DeleteOptions) => void | Promise<void>): this
  on (eventName: 'post-delete-one', listener: (result: TSchema | null, filter: Filter<TSchema>, options?: DeleteOptions) => void | Promise<void>): this
  on (eventName: 'pre-delete-many', listener: (filter?: Filter<TSchema>, options?: DeleteOptions) => void | Promise<void>): this
  on (eventName: 'post-delete-many', listener: (result: TSchema[], filter?: Filter<TSchema>, options?: DeleteOptions) => void | Promise<void>): this
  on (eventName: 'pre-delete-by-id', listener: (id: string, options?: DeleteOptions) => void | Promise<void>): this
  on (eventName: 'post-delete-by-id', listener: (result: TSchema | null, id: string, options?: DeleteOptions) => void | Promise<void>): this
  on (eventName: 'post-delete', listener: () => void | Promise<void>): this
  on (eventName: 'pre-reset', listener: () => void | Promise<void>): this
  on (eventName: 'post-reset', listener: () => void | Promise<void>): this
}
