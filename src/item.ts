import { Context, checkTimer, Argv, User, isInteger, Random, Dict } from 'koishi'
import { Adventurer, Show } from './utils'
import Event from './event'
import Phase from './phase'
import Rank from './rank'

type Note = (user: Adventurer.Readonly<'flag' | 'warehouse'>) => string

interface Item {
  name: string
  rarity?: Item.Rarity
  description: string
  maxCount?: number
  value?: number
  bid?: number
  onGain?: Event
  onLose?: Event
  beforePick?: (session: Adventurer.Session) => boolean
  lottery?: number
  plot?: boolean
  note?: Note
}

namespace Item {
  export enum rarities { N, R, SR, SSR, EX, SP }
  export type Rarity = keyof typeof rarities

  type Data = Dict<Item> & Item[] & Record<Rarity, Item[]>

  export const data: Data = [] as any

  data.N = []
  data.R = []
  data.SR = []
  data.SSR = []
  data.EX = []
  data.SP = []

  function checkHidden(user: Pick<User, 'gains'>, target: string) {
    return !(target in user.gains)
  }

  export function load(item: Item) {
    if (!item.maxCount) item.maxCount = 10
    data[item.rarity].push(item)
    data[item.name] = item
    data.push(item)
    Show.redirect(item.name, 'item', checkHidden)
  }

  export function note(name: string, note: Note) {
    data[name].note = note
  }

  export function onGain(name: string, event: Event) {
    data[name].onGain = event
  }

  export function onLose(name: string, event: Event) {
    data[name].onLose = event
  }

  export function beforePick(name: string, event: (session: Adventurer.Session) => boolean) {
    data[name].beforePick = event
  }

  export interface Config {
    createBuyer?: (user: User.Observed<'timers'>) => (name: string) => number
    createSeller?: (user: User.Observed<'timers'>) => (name: string) => number
  }

  type Keys<O, T = any> = { [K in keyof O]: O[K] extends T ? K : never }[keyof O]

  export function pick(items: Item[], session: Adventurer.Session, key?: Keys<Item, number>, fallback = 0) {
    const weightEntries = items.map<[string, number]>((item) => {
      const probability = key ? item[key] ?? fallback : 1
      if (!probability || item.beforePick?.(session)) return [item.name, 0]
      return [item.name, probability]
    })
    return Item.data[Random.weightedPick(Object.fromEntries(weightEntries))]
  }

  export function lose(session: Adventurer.Session, name: string, count = 1) {
    if (session.user.warehouse[name]) {
      session.user.warehouse[name] -= count
    }
    const item = Item.data[name]
    const result = item.onLose?.(session)
    if (result) return result
  }

  const MAX_RECENT_ITEMS = 10

  export function gain(session: Adventurer.Session, name: string, count = 1) {
    const item = Item.data[name]
    const output: string[] = []
    session.user.gains[name] = (session.user.gains[name] || 0) + count
    session.user.warehouse[name] = (session.user.warehouse[name] || 0) + count

    // update recent
    if (item.rarity !== 'SP') {
      const index = session.user.recent.indexOf(name)
      if (index >= 0) {
        session.user.recent.splice(index, 1)
      } else {
        session.user.recent.splice(MAX_RECENT_ITEMS - 1, Infinity)
      }
      session.user.recent.unshift(name)
    }

    // trigger event
    const result = item.onGain?.(session)
    if (result) output.push(result)

    return output.join('\n')
  }

  function getRarityIndex(name: string) {
    name = name.split('??')[0]
    return Item.data[name].rarity
  }

  export type Pack = string[] | Dict<number>

  export function format(items: Pack, list?: string[]): string {
    if (Array.isArray(items)) {
      return items
        .sort((a, b) => Item.rarities[getRarityIndex(a)] - Item.rarities[getRarityIndex(b)])
        .map(i => `${i}???${getRarityIndex(i)}???`)
        .join('???')
    } else {
      return (list || Object.keys(items)).map(name => `${name}??${items[name]}`).join('???')
    }
  }

  export function checkOverflow(session: Adventurer.Session, names: Iterable<string> = session._gains) {
    const itemMap: Dict<number> = {}
    for (const name of names) {
      const { maxCount, value } = Item.data[name]
      const overflow = session.user.warehouse[name] - maxCount
      if (overflow > 0) {
        if (value && !checkTimer('$shop', session.user)) {
          itemMap[name] = overflow
        } else {
          session.user.warehouse[name] = maxCount
        }
      }
    }
    if (Object.keys(itemMap).length) {
      return '?????????????????????' + Event.sell(itemMap)(session)
    }
  }

  async function argvToMap(argv: Argv) {
    const { args } = argv
    const itemMap: Dict<number> = {}
    for (let i = 0; i < args.length; i++) {
      const name = args[i]
      if (!data[name]) {
        return suggest(argv, i)
      }
      const nextArg = args[++i]
      if (nextArg === '*') {
        itemMap[name] = Infinity
      } else if (nextArg === '?') {
        itemMap[name] = itemMap[name] ?? -Infinity
      } else {
        const count = +args[i] * 0 === 0 ? +args[i] : (--i, 1)
        itemMap[name] = (itemMap[name] === -Infinity ? 0 : itemMap[name] || 0) + count
      }
    }
    return itemMap
  }

  export function suggest({ session, args, next, command }: Argv, index = 0) {
    args = args.slice()
    if (args.length === 1) {
      session.content = `${command.name}:${args[0]}`
    }
    return session.suggest({
      next,
      target: args[index],
      items: Item.data.map(item => item.name),
      prefix: `???????????????${args[index]}??????`,
      suffix: '????????????????????????????????????????????????',
      async apply(suggestion, next) {
        args.splice(index, 1, suggestion)
        return session.execute({ command, args, next })
      },
    })
  }

  export function apply(ctx: Context) {
    ctx.command('adv/item [item]', '????????????', { maxUsage: 100, usageName: 'show' })
      .userFields(['id', 'warehouse', 'achievement', 'name', 'gains', 'authority', 'timers', 'flag'])
      .shortcut(/^(??????|??????)(??????|??????|??????|??????)$/)
      .shortcut('??????', { fuzzy: true })
      .option('current', '-v ??????????????????')
      .option('total', '-V ??????????????????')
      .option('format', '/ <format:string> ????????????????????????', { hidden: true })
      .action(async (argv, name) => {
        const { session, next, options } = argv
        const { warehouse, gains } = session.user

        if (!name) {
          const achieved = Object.keys(warehouse).length
          const itemMap: Record<Item.Rarity, string[]> = { N: [], R: [], SR: [], SSR: [], EX: [], SP: [] }
          for (const item in warehouse) {
            itemMap[Item.data[item].rarity].push(item)
          }
          return [
            `${session.username}????????????????????? ${Item.data.length} ??????????????? ${achieved} ??????`,
            ...['N', 'R', 'SR', 'SSR', 'EX', 'SP'].map((rarity: Item.Rarity) => {
              const { length } = itemMap[rarity]
              let output = `${rarity} (${length}/${Item.data[rarity].length})`
              if (length) output += '???' + format(warehouse, itemMap[rarity])
              return output
            }),
            '?????????????????????????????????????????????????????????????????????????????????<?????????>??????',
          ].join('\n')
        }

        const item = Item.data[name]
        if (!item) return suggest(argv)
        if (!(name in warehouse)) return options['pass'] ? next() : '????????????????????????'

        if (options.current) return '' + warehouse[name]
        if (options.total) return '' + gains[name]

        if (session._redirected && options.format && Item.data[name]) {
          return options.format
            .replace(/%%/g, '@@__PLACEHOLDER__@@')
            .replace(/%n/g, name)
            .replace(/%r/g, item.rarity)
            .replace(/%c/g, '' + warehouse[name])
            .replace(/%g/g, '' + gains[name])
            .replace(/%m/g, '' + item.maxCount)
            .replace(/%d/g, '' + item.description)
        }

        const source: string[] = []
        const output = [`${item.name}???${item.rarity}???`]
        if (Item.data[name]) {
          output.push(`???????????????${warehouse[name]} ???`)
          output.push(`???????????????${gains[name]} ???`)
          output.push(`???????????????${item.maxCount} ???`)
        }
        if (item.rarity !== 'SP' && item.lottery !== 0) source.push('??????')
        if ('fishing' in item) source.push('??????')
        const value = ctx.app.adventure.createSeller(session.user)(name)
        if (value) {
          output.push(`???????????????${value}???`)
        }
        const bid = ctx.app.adventure.createBuyer(session.user)(name)
        if (bid) {
          source.push('??????')
          output.push(`???????????????${bid}???`)
        }
        if (item.plot || !source.length) source.push('??????')
        output.push(`???????????????${source.join(' / ')}`)
        const result = item.note?.(session.user)
        if (result) output.push(result)
        output.push(item.description)
        return output.join('\n')
      })

    ctx.command('item.add', '????????????', { authority: 4 })
      .userFields(Adventurer.fields)
      .adminUser(async ({ session }, item, count = '1') => {
        if (!Item.data[item]) return `??????????????????${item}??????`
        const nCount = Number(count)
        if (!isInteger(nCount) || nCount <= 0) return '???????????????'
        await Phase.dispatch(session, [Event.gain({ [item]: nCount })])
        await session.user.$update()
        return ''
      })

    ctx.command('item.remove', '????????????', { authority: 4 })
      .userFields(Adventurer.fields)
      .adminUser(async ({ session }, item, count = '1') => {
        if (!Item.data[item]) return `??????????????????${item}??????`
        const nCount = Number(count)
        if (!isInteger(nCount) || nCount <= 0) return '???????????????'
        await Phase.dispatch(session, [Event.lose({ [item]: nCount })])
        await session.user.$update()
        return ''
      })

    ctx.command('item.set', '??????????????????', { authority: 4 })
      .usage('???????????????????????????????????????????????????')
      .userFields(['warehouse'])
      .adminUser(({ session }, item, count) => {
        if (!Item.data[item]) return `??????????????????${item}??????`
        const nCount = Number(count)
        if (!isInteger(nCount) || nCount < 0) return '???????????????'
        session.user.warehouse[item] = nCount
      })

    ctx.command('adv/buy [item] [count]', '????????????', { maxUsage: 100 })
      .checkTimer('$system')
      .checkTimer('$shop')
      .userFields(Adventurer.fields)
      .shortcut('??????', { fuzzy: true })
      .shortcut('??????', { fuzzy: true })
      .shortcut('??????', { fuzzy: true })
      .action(async (argv, ...args) => {
        const { session } = argv
        const message = Phase.checkStates(session)
        if (message) return message
        if (session.user.progress) return '??????????????????????????????????????????????????????????????????????????????'

        const toBid = ctx.app.adventure.createBuyer(session.user)
        if (!args.length) {
          const output = Item.data
            .map(i => ({ ...i, bid: toBid(i.name) }))
            .filter(p => p.bid)
            .sort((a, b) => a.bid > b.bid ? 1 : a.bid < b.bid ? -1 : Item.rarities[a.rarity] - Item.rarities[b.rarity])
            .map(p => `${p.name}???${p.rarity}??? ${p.bid}???`)
          output.unshift('????????? ????????????')
          return output.join('\n')
        }

        const buyMap = await argvToMap(argv)
        if (!buyMap) return

        let moneyLost = 0
        const user = session.user
        for (const name in buyMap) {
          const count = buyMap[name]
          const { maxCount } = Item.data[name]
          const bid = toBid(name)
          if (!bid) return `?????????${name}??????????????????`
          if (count === Infinity) {
            if (user.warehouse[name] >= maxCount) {
              delete buyMap[name]
              continue
            } else {
              buyMap[name] = maxCount - (user.warehouse[name] || 0)
            }
          } else if (count === -Infinity) {
            if (user.warehouse[name]) {
              delete buyMap[name]
              continue
            } else {
              buyMap[name] = 1
            }
          } else {
            if (!isInteger(count) || count <= 0) return '???????????????'
            if ((user.warehouse[name] || 0) + count > maxCount) return '???????????????????????????'
          }
          moneyLost += buyMap[name] * bid
          if (moneyLost > user.money) return '???????????????'
        }

        const entries = Object.entries(buyMap)
        if (!entries.length) return '???????????????????????????'

        const hints = [Event.buy(buyMap)(session)]
        session.app.emit('adventure/check', session as any, hints)

        await user.$update()
        await session.send(hints.join('\n'))
      })

    ctx.command('adv/sell [item] [count]', '????????????', { maxUsage: 100 })
      .checkTimer('$system')
      .checkTimer('$shop')
      .userFields(Adventurer.fields)
      .shortcut('??????', { fuzzy: true })
      .shortcut('??????', { fuzzy: true })
      .shortcut('??????', { fuzzy: true })
      .shortcut('??????', { fuzzy: true })
      .action(async (argv, ...args) => {
        const { session } = argv
        const message = Phase.checkStates(session)
        if (message) return message
        if (session.user.progress) return '??????????????????????????????????????????????????????????????????????????????'

        const toValue = ctx.app.adventure.createSeller(session.user)
        if (!args.length) {
          const output = Item.data
            .filter(p => p.value && session.user.warehouse[p.name])
            .sort((a, b) => a.value > b.value ? 1 : a.value < b.value ? -1 : Item.rarities[a.rarity] - Item.rarities[b.rarity])
            .map(p => `${p.name}???${p.rarity}??? ${toValue(p.name)}???`)
          output.unshift('????????? ????????????')
          return output.join('\n')
        }

        const sellMap = await argvToMap(argv)
        if (!sellMap) return

        const user = session.user
        for (const name in sellMap) {
          const count = sellMap[name]
          const { maxCount, value } = Item.data[name]
          if (!value) return `?????????${name}??????????????????`
          if (count === Infinity) {
            if (user.warehouse[name]) {
              sellMap[name] = user.warehouse[name]
            } else {
              delete sellMap[name]
            }
          } else if (count === -Infinity) {
            if (user.warehouse[name] >= maxCount) {
              sellMap[name] = maxCount - user.warehouse[name] + 1
            } else {
              delete sellMap[name]
            }
          } else {
            if (!isInteger(count) || count <= 0) return '???????????????'
            if ((user.warehouse[name] || 0) < count) return '???????????????????????????'
          }
        }

        const entries = Object.entries(sellMap)
        if (!entries.length) return '???????????????????????????'

        const result = ctx.bail('adventure/before-sell', sellMap, session)
        if (result) return result

        if (!user.progress && entries.length === 1 && entries[0][1] === 1 && entries[0][0] in Phase.salePlots) {
          const saleAction = Phase.salePlots[entries[0][0]]
          await session.observeUser(Adventurer.fields)
          const progress = Adventurer.getValue(saleAction, user, null)
          if (progress) {
            const _meta = session as Adventurer.Session
            _meta.user['_skip'] = session._skipAll
            await Phase.setProgress(_meta.user, progress)
            return Phase.start(_meta)
          }
        }

        const hints = [Event.sell(sellMap)(session)]
        session.app.emit('adventure/check', session as any, hints)
        await user.$update()
        await session.send(hints.join('\n'))
      })

    ctx.on('adventure/rank', (name) => {
      let isGain = false
      if (name.startsWith('??????')) {
        name = name.slice(2)
        isGain = true
      }
      return Item.data[name] && [isGain ? 'rank.gain' : 'rank.item', name]
    })

    ctx.command('rank.item [name]', '??????????????????????????????')
      .useRank()
      .action(async (argv, name) => {
        const { session, options } = argv
        if (!name) return '?????????????????????'
        if (!Item.data[name]) return suggest(argv)
        return Rank.show({
          names: ['??????' + name],
          value: `json_extract(\`warehouse\`, '$."${name}"')`,
          format: ' ???',
        }, session, options)
      })

    ctx.command('rank.gain [name]', '????????????????????????????????????')
      .useRank()
      .action(async (argv, name) => {
        const { session, options } = argv
        if (!name) return '?????????????????????'
        if (!Item.data[name]) return suggest(argv)
        return Rank.show({
          names: ['????????????' + name],
          value: `json_extract(\`gains\`, '$."${name}"')`,
          format: ' ???',
        }, session, options)
      })
  }
}

export default Item
