import { base64VLQEncode } from '../utils'

import type { Resolver } from '../types'

interface SourceMap {
  sources: string[],
  mappings: string
}

const vueRE = /\.vue$/

export function VueResolver(): Resolver {
  return {
    name: 'vue',
    supports(id) {
      return vueRE.test(id)
    },
    transform({ id, code, program, service }) {
      const sourceFile =
        program.getSourceFile(id) ||
        program.getSourceFile(id + '.ts') ||
        program.getSourceFile(id + '.js') ||
        program.getSourceFile(id + '.tsx') ||
        program.getSourceFile(id + '.jsx')

      if (!sourceFile) return []

      const outputs = service.getEmitOutput(sourceFile.fileName, true).outputFiles.map(file => {
        return {
          path: file.name,
          content: file.text
        }
      })

      if (!program.getCompilerOptions().declarationMap) return outputs

      const [beforeScript] = code.split(/\s*<script.*>/)
      const beforeLines = Math.max(beforeScript.split('\n').length - 1, 0)

      for (const output of outputs) {
        if (output.path.endsWith('.map')) {
          try {
            const sourceMap: SourceMap = JSON.parse(output.content)

            sourceMap.sources = sourceMap.sources.map(source =>
              source.replace(/\.vue\.ts$/, '.vue')
            )

            if (beforeLines) {
              sourceMap.mappings = `${base64VLQEncode([0, 0, beforeLines, 0])};${
                sourceMap.mappings
              }`
            }

            output.content = JSON.stringify(sourceMap)
          } catch (e) {}
        }
      }

      return outputs
    }
  }
}
