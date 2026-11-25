#!/usr/bin/env node
/**
 * Public artifact privacy gate for nhatoSG.
 * Scans only text artifacts that can be published; never prints matched content.
 * Exit code 0 = pass, 1 = blocked.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const PAGE_DIR = path.join(ROOT, 'p');
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.json', '.xml', '.txt', '.css']);
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'tools']);

const forbiddenRules = [
  { name: 'private-address-marker', regex: /\[SO_NHA\]|vip_location_hint|\bso_nha\b/i },
  { name: 'public-member-relay', regex: /ntfy\.sh|REGISTER_MEMBER|member_sync|counterapi\.dev/i },
  // Match likely secret values, not harmless field names or localStorage cleanup code.
  { name: 'credential-value', regex: /(?:api[_-]?key|access_token|refresh_token|private_key|client_secret)\s*[:=]\s*["'][^"']{12,}["']/i },
  { name: 'private-note-marker', regex: /owner_phone|tenant_name|customer_phone|lead_source|internal_note/i },
];

const failures = [];
const scanned = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) scanned.push(full);
  }
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

walk(ROOT);

if (fs.existsSync(PAGE_DIR)) {
  for (const name of fs.readdirSync(PAGE_DIR)) {
    if (!name.toLowerCase().endsWith('.html')) continue;
    if (!/^NSG-\d{4}\.html$/.test(name)) {
      failures.push({ file: `p/${name}`, rule: 'noncanonical-page-filename' });
    }
  }
}

for (const file of scanned) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    failures.push({ file: rel(file), rule: 'unreadable-public-artifact' });
    continue;
  }
  for (const rule of forbiddenRules) {
    if (rule.regex.test(content)) failures.push({ file: rel(file), rule: rule.name });
  }
}

console.log(`Public privacy scan: ${failures.length ? 'BLOCKED' : 'PASS'}`);
console.log(`Text artifacts scanned: ${scanned.length}`);
if (failures.length) {
  const unique = new Map();
  for (const item of failures) unique.set(`${item.file}\0${item.rule}`, item);
  for (const item of unique.values()) console.log(`- ${item.file} [${item.rule}]`);
  console.log('No matched content was printed. Resolve findings before publishing.');
  process.exitCode = 1;
}
