import { Date as D, isArray, isJSON, isNull, isNumber, isObject, isString } from '@kakang/validator'
import { Document, UpdateFilter } from 'mongodb'

export function isUpdateQuery <TSchema extends Document = Document> (docs: UpdateFilter<TSchema> | Partial<TSchema>): docs is UpdateFilter<TSchema> {
  const keys = Object.keys(docs)
  for (let i = keys.length - 1; i >= 0; i--) {
    if (['$currentDate', '$inc', '$min', '$max', '$mul', '$rename', '$set', '$setOnInsert', '$unset', '$addToSet', '$pop', '$pull', '$push', '$pushAll', '$bit'].includes(keys[i])) return true
  }
  return false
}

export function retrieveUpdateQueryData<TSchema extends Document = Document> (docs: UpdateFilter<TSchema> | Partial<TSchema>): TSchema {
  return isUpdateQuery(docs) ? Object.assign({}, docs.$set) as TSchema : docs as TSchema
}

export function mergeUpdateQueryData<TSchema extends Document = Document> (from: UpdateFilter<TSchema> | Partial<TSchema>, to: UpdateFilter<TSchema> | Partial<TSchema>): UpdateFilter<TSchema> | Partial<TSchema> {
  const fromD = retrieveUpdateQueryData(from)
  const toD = retrieveUpdateQueryData(to)
  const data = Object.assign({}, fromD, toD)
  let result = {}
  if (isUpdateQuery(from)) result = { ...result, ...from }
  if (isUpdateQuery(to)) result = { ...result, ...to }
  return { ...result, $set: data }
}

export function normalize (text: any): unknown {
  // security guard
  const tmp = isObject(text) && !isNull(text) ? JSON.stringify(text) : String(text)
  if (tmp.includes('$function') || tmp.includes('$accumulator')) throw new Error('invalid operator found')

  // start normalize
  // 1. if the string is wrapped by '{' and '}'
  //    we treat it as JSON
  if (isString(text) && text.startsWith('{') && text.endsWith('}')) {
    return normalize(JSON.parse(text))
  }
  // 2. if the string equal to 'true'
  //    we treat it as true
  if (tmp.toLowerCase() === 'true') return true
  // 2. if the string equal to 'false'
  //    we treat it as false
  if (tmp.toLowerCase() === 'false') return false
  // 3. if the string is number
  //    we treat it as number
  if (!isNaN(tmp as never as number)) return Number(tmp)
  // 4. if the string match ISO8601 standard
  //    we treat it as Date
  if (D.isISO8601Date(tmp)) return new Date(tmp)
  // 5. if the object match array
  //    we normalize each item inside
  if (isArray(text)) return text.map(normalize)
  // 6. if the object is JSON
  //    we normalize each pair of key-value
  if (!isNumber(text) && !isString(text) && !isArray(text) && isJSON(text)) {
    const o = JSON.parse(tmp)
    Object.entries(o).forEach(function ([k, v]) {
      // keep $expr $dateFromString work as before
      // $regex must be string
      if (k === 'dateString' || k === '$regex') {
        o[k] = String(v)
      } else {
        o[k] = normalize(v as string)
      }
    })
    return o
  }
  // 7. if all of the assumption not matcch
  //    we return the raw
  return text
}

const kStart = '{['
const kEnd = '}]'
const kKeyAllowedCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.$'
const kDelimiter = ':,'

export function findNextPair (text: string, startIndex = 0): { startIndex: number, endIndex: number, key: string, value: string } {
  const result = {
    startIndex,
    endIndex: 0,
    key: '',
    value: ''
  }
  let foundKey = false
  let nested = 0

  for (let i = result.startIndex; i < text.length; i++) {
    const char = text[i]
    if (!foundKey) {
      // looking for key
      if (kKeyAllowedCharacters.includes(char)) result.key += char
      else if (char === kDelimiter[0]) foundKey = true
    } else {
      // looking for value
      if (kStart.includes(char)) nested++
      if (kEnd.includes(char)) nested--
      if (nested === 0 && char === kDelimiter[1]) {
        result.endIndex = i + 1
        break
      }
      result.value += char
    }
  }

  return result
}

export function transformRegExpSearch (text: string | Record<string, unknown>): unknown {
  if (typeof text === 'string' && !text.startsWith('{') && !text.endsWith('}')) {
    return { $regex: text, $options: 'i' }
  } else {
    return text
  }
}
