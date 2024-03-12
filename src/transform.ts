import { dirname, isAbsolute, relative, resolve } from 'node:path'

import MagicString from 'magic-string'
import ts from 'typescript'
import { isRegExp, normalizePath } from './utils'

import type { Alias } from 'vite'

const globSuffixRE = /^((?:.*\.[^.]+)|(?:\*+))$/

export function normalizeGlob(path: string) {
  if (/[\\/]$/.test(path)) {
    return path + '**'
  } else if (!globSuffixRE.test(path.split(/[\\/]/).pop()!)) {
    return path + '/**'
  }

  return path
}

function walkSourceFile(
  sourceFile: ts.SourceFile,
  callback: (node: ts.Node, parent: ts.Node) => void | boolean
) {
  function walkNode(
    node: ts.Node,
    parent: ts.Node,
    callback: (node: ts.Node, parent: ts.Node) => void | boolean
  ) {
    if (callback(node, parent) !== false) {
      node.forEachChild(child => walkNode(child, node, callback))
    }
  }

  sourceFile.forEachChild(child => walkNode(child, sourceFile, callback))
}

function isAliasMatch(alias: Alias, importer: string) {
  if (isRegExp(alias.find)) return alias.find.test(importer)
  if (importer.length < alias.find.length) return false
  if (importer === alias.find) return true

  return (
    importer.indexOf(alias.find) === 0 &&
    (alias.find.endsWith('/') || importer.substring(alias.find.length)[0] === '/')
  )
}

function transformAlias(
  importer: string,
  dir: string,
  aliases: Alias[],
  aliasesExclude: (string | RegExp)[]
) {
  if (
    aliases.length &&
    !aliasesExclude.some(e => (isRegExp(e) ? e.test(importer) : String(e) === importer))
  ) {
    const matchedAlias = aliases.find(alias => isAliasMatch(alias, importer))

    if (matchedAlias) {
      const replacement = isAbsolute(matchedAlias.replacement)
        ? normalizePath(relative(dir, matchedAlias.replacement))
        : normalizePath(matchedAlias.replacement)

      const endsWithSlash =
        typeof matchedAlias.find === 'string'
          ? matchedAlias.find.endsWith('/')
          : importer.match(matchedAlias.find)![0].endsWith('/')
      const truthPath = importer.replace(
        matchedAlias.find,
        replacement + (endsWithSlash ? '/' : '')
      )
      const normalizedPath = normalizePath(relative(dir, resolve(dir, truthPath)))

      return normalizedPath.startsWith('.') ? normalizedPath : `./${normalizedPath}`
    }
  }

  return importer
}

export function transformCode(options: {
  filePath: string,
  content: string,
  aliases: Alias[],
  aliasesExclude: (string | RegExp)[],
  staticImport: boolean,
  clearPureImport: boolean
}) {
  const s = new MagicString(options.content)
  const ast = ts.createSourceFile('a.ts', options.content, ts.ScriptTarget.Latest)

  const dir = dirname(options.filePath)

  const importMap = new Map<string, Set<string>>()
  const usedDefault = new Map<string, string>()

  let indexCount = 0

  walkSourceFile(ast, (node, parent) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause) {
        options.clearPureImport && s.remove(node.pos, node.end)
      } else if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        (node.importClause.name ||
          (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)))
      ) {
        const libName = transformAlias(
          node.moduleSpecifier.text,
          dir,
          options.aliases,
          options.aliasesExclude
        )
        const importSet =
          importMap.get(libName) ?? importMap.set(libName, new Set<string>()).get(libName)!

        if (node.importClause.name && !usedDefault.has(libName)) {
          const usedType = node.importClause.name.escapedText as string

          usedDefault.set(libName, usedType)
          importSet.add(`default as ${usedType}`)
        }

        if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          node.importClause.namedBindings.elements.forEach(element => {
            importSet.add(element.name.escapedText as string)
          })
        }

        s.remove(node.pos, node.end)
      }

      return false
    }

    if (
      ts.isImportTypeNode(node) &&
      node.qualifier &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isIdentifier(node.qualifier) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const libName = transformAlias(
        node.argument.literal.text,
        dir,
        options.aliases,
        options.aliasesExclude
      )

      if (!options.staticImport) {
        s.update(node.argument.literal.pos, node.argument.literal.end, `'${libName}'`)

        return false
      }

      const importSet =
        importMap.get(libName) ?? importMap.set(libName, new Set<string>()).get(libName)!

      let usedType = node.qualifier.escapedText as string

      if (usedType === 'default') {
        usedType =
          usedDefault.get(libName) ??
          usedDefault.set(libName, `__DTS_DEFAULT_${indexCount++}__`).get(libName)!

        importSet.add(`default as ${usedType}`)
        s.update(node.qualifier.pos, node.qualifier.end, usedType)
      } else {
        importSet.add(usedType)
      }

      // s.update(node.pos, node.end, ` ${usedType}`)
      if (ts.isImportTypeNode(parent) && parent.typeArguments && parent.typeArguments[0] === node) {
        s.remove(node.pos, node.argument.end + 2)
      } else {
        s.update(node.pos, node.argument.end + 2, ' ')
      }

      return !!node.typeArguments
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const libName = transformAlias(
        node.arguments[0].text,
        dir,
        options.aliases,
        options.aliasesExclude
      )

      s.update(node.arguments[0].pos, node.arguments[0].end, `'${libName}'`)

      return false
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const libName = transformAlias(
        node.moduleSpecifier.text,
        dir,
        options.aliases,
        options.aliasesExclude
      )

      s.update(node.moduleSpecifier.pos, node.moduleSpecifier.end, ` '${libName}'`)

      return false
    }
  })

  importMap.forEach((importSet, libName) => {
    s.prepend(`import { ${Array.from(importSet).join(', ')} } from '${libName}';\n`)
  })

  return s.toString()
}

export function hasExportDefault(content: string) {
  const ast = ts.createSourceFile('a.ts', content, ts.ScriptTarget.Latest)

  let has = false

  walkSourceFile(ast, node => {
    if (ts.isExportAssignment(node)) {
      has = true
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        if (element.name.escapedText === 'default') {
          has = true
        }
      }
    }

    return false
  })

  return has
}
