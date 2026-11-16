import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { parse } from './parse.js';

const inputPath = resolve(process.env.MAKEFUN_INPUT_DIR || '/input', 'cases.json');
const outputPath = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output', 'html.json');
const documents: Array<{ id: string; markdown: string }> = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const rendered = documents.map(document => parse(document.markdown));
fs.writeFileSync(outputPath, JSON.stringify(rendered));
