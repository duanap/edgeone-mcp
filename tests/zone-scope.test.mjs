import test from 'node:test';
import assert from 'node:assert/strict';

const edgeModule = await import('../src/edgeone-client.mjs').catch(() => ({}));

test('sanitizeRuleData redacts sensitive headers and secret-like fields', () => {
  assert.equal(typeof edgeModule.sanitizeRuleData, 'function', 'rule sanitizer implementation is missing');
  const result = edgeModule.sanitizeRuleData([{
    RuleId: 'rule-1',
    Actions: [{
      RequestHeaders: [
        { Name: 'X-Starkey-Origin-Secret', Value: 'do-not-return-this' },
        { Name: 'X-App-Key', Value: 'also-do-not-return-this' },
        { Name: 'X-Public-Mode', Value: 'public-value' },
      ],
      AuthorizationToken: 'also-private',
    }],
  }]);

  assert.deepEqual(result, [{
    RuleId: 'rule-1',
    Actions: [{
      RequestHeaders: [
        { Name: 'X-Starkey-Origin-Secret', Value: '[REDACTED]' },
        { Name: 'X-App-Key', Value: '[REDACTED]' },
        { Name: 'X-Public-Mode', Value: 'public-value' },
      ],
      AuthorizationToken: '[REDACTED]',
    }],
  }]);
});
