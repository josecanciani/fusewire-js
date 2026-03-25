import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '../src');

/**
 * Code style tests - enforce consistent formatting
 * 
 * This prevents accidental formatting changes from tools like oxfmt
 * that might not respect our project conventions.
 */
describe('Code Style', () => {
	function getAllJsFiles(dir) {
		const files = [];
		const entries = readdirSync(dir, { withFileTypes: true });
		
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...getAllJsFiles(fullPath));
			} else if (entry.name.endsWith('.js')) {
				files.push(fullPath);
			}
		}
		
		return files;
	}

	const sourceFiles = getAllJsFiles(srcDir);

	describe('Indentation', () => {
		it('uses 4 spaces for indentation (not tabs)', () => {
			for (const file of sourceFiles) {
				const content = readFileSync(file, 'utf-8');
				const lines = content.split('\n');
				
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					// Check if line starts with tab character
					if (line.startsWith('\t')) {
						assert.fail(
							`${file}:${i + 1} uses tab indentation. Use 4 spaces instead.\nLine: ${line.substring(0, 50)}...`,
						);
					}
				}
			}
		});
	});

	describe('String Quotes', () => {
		it('prefers single quotes for strings (informational check)', () => {
			// This is a simplified check - just flag obvious cases
			// Regexes and special cases are allowed to use double quotes
			
			for (const file of sourceFiles) {
				const content = readFileSync(file, 'utf-8');
				
				// Only check for import/export statements with double quotes
				const importExportPattern = /^(import|export).*["]/gm;
				const matches = content.match(importExportPattern);
				
				if (matches && matches.length > 0) {
					const lines = content.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].match(/^(import|export).*["]/)) {
							assert.fail(
								`${file}:${i + 1} uses double quotes in import/export. Use single quotes.\nLine: ${lines[i].trim()}`,
							);
						}
					}
				}
			}
		});
	});
});
