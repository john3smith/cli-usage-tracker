'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveRelayPython } = require('../src/main/providers/claude');

test('relay prefers independent Python when both environments exist', () => {
  assert.equal(resolveRelayPython('fixture', () => true), path.join('fixture', '.venv-py312', 'Scripts', 'python.exe'));
});
test('relay supports legacy environment and rejects missing runtimes', () => {
  assert.equal(resolveRelayPython('fixture', p => p.includes(`${path.sep}.venv${path.sep}`)),
    path.join('fixture', '.venv', 'Scripts', 'python.exe'));
  assert.throws(() => resolveRelayPython('fixture', () => false), /runtime unavailable/);
});
