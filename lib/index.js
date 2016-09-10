'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.rules = undefined;

var _graphql = require('graphql');

var _lodash = require('lodash');

var _graphqlConfigParser = require('graphql-config-parser');

var _deasync = require('deasync');

var graphQLValidationRuleNames = ['UniqueOperationNames', 'LoneAnonymousOperation', 'KnownTypeNames', 'FragmentsOnCompositeTypes', 'VariablesAreInputTypes', 'ScalarLeafs', 'FieldsOnCorrectType', 'UniqueFragmentNames',
//'KnownFragmentNames', -> any interpolation
//'NoUnusedFragments', -> any standalone fragment
'PossibleFragmentSpreads', 'NoFragmentCycles', 'UniqueVariableNames', 'NoUndefinedVariables', 'NoUnusedVariables', 'KnownDirectives', 'KnownArgumentNames', 'UniqueArgumentNames', 'ArgumentsOfCorrectType', 'ProvidedNonNullArguments', 'DefaultValuesOfCorrectType', 'VariablesInAllowedPosition', 'OverlappingFieldsCanBeMerged', 'UniqueInputFieldNames'];

// Omit these rules when in Relay env
var relayRuleNames = (0, _lodash.without)(graphQLValidationRuleNames, 'ScalarLeafs', 'ProvidedNonNullArguments', 'KnownDirectives', 'NoUndefinedVariables');

var graphQLValidationRules = graphQLValidationRuleNames.map(function (ruleName) {
  return require('graphql/validation/rules/' + ruleName)[ruleName];
});

var relayGraphQLValidationRules = relayRuleNames.map(function (ruleName) {
  return require('graphql/validation/rules/' + ruleName)[ruleName];
});

var unpackedSchemaJson = parseConfigAndResolveSchema();

var rules = {
  'template-strings': function templateStrings(context) {
    var _context$options$ = context.options[0];
    var env = _context$options$.env;
    var tagNameOption = _context$options$.tagName;

    // Validate env

    if (env && env !== 'lokka' && env !== 'relay' && env !== 'apollo') {
      throw new Error('Invalid option for env, only `apollo`, `lokka`, and `relay` supported.');
    }

    // Validate tagName and set default
    var tagName = void 0;
    if (tagNameOption) {
      tagName = tagNameOption;
    } else if (env === 'relay') {
      tagName = 'Relay.QL';
    } else {
      tagName = 'gql';
    }

    var schema = (0, _graphql.buildClientSchema)(unpackedSchemaJson);

    return {
      TaggedTemplateExpression: function TaggedTemplateExpression(node) {
        var tagNameSegments = tagName.split('.').length;
        if (tagNameSegments === 1) {
          // Check for single identifier, like 'gql'
          if (node.tag.type === 'Identifier' && node.tag.name !== tagName) {
            return;
          }
        } else if (tagNameSegments === 2) {
          // Check for dotted identifier, like 'Relay.QL'
          if (node.tag.type === 'MemberExpression' && node.tag.object.name + '.' + node.tag.property.name !== tagName) {
            return;
          }
        }

        var text = void 0;
        try {
          text = replaceExpressions(node.quasi, context, env);
        } catch (e) {
          if (e.message !== 'Invalid interpolation') {
            console.log(e);
          }

          return;
        }

        // Re-implement syntax sugar for fragment names, which is technically not valid
        // graphql
        if ((env === 'lokka' || env === 'relay') && /fragment\s+on/.test(text)) {
          text = text.replace('fragment', 'fragment _');
        }

        var ast = void 0;

        try {
          ast = (0, _graphql.parse)(text);
        } catch (error) {
          context.report({
            node: node,
            message: error.message.split('\n')[0],
            loc: locFrom(node, error)
          });
          return;
        }

        var rules = env === 'relay' ? relayGraphQLValidationRules : graphQLValidationRules;

        var validationErrors = schema ? (0, _graphql.validate)(schema, ast, rules) : [];

        if (validationErrors && validationErrors.length > 0) {
          context.report({
            node: node,
            message: validationErrors[0].message,
            loc: locFrom(node, validationErrors[0])
          });
          return;
        }
      }
    };
  }
};

function locFrom(node, error) {
  var location = error.locations[0];

  var line = void 0;
  var column = void 0;
  if (location.line === 1) {
    line = node.loc.start.line;
    column = node.loc.start.col + location.col;
  } else {
    line = node.loc.start.line + location.line;
    column = location.column - 1;
  }

  return {
    line: line,
    column: column
  };
}

function replaceExpressions(node, context, env) {
  var chunks = [];

  node.quasis.forEach(function (element, i) {
    var chunk = element.value.cooked;

    chunks.push(chunk);

    if (!element.tail) {
      var value = node.expressions[i];

      // Preserve location of errors by replacing with exactly the same length
      var nameLength = value.end - value.start;

      if (env === 'relay' && /:\s*$/.test(chunk)) {
        // The chunk before this one had a colon at the end, so this
        // is a variable

        // Add 2 for brackets in the interpolation
        var placeholder = strWithLen(nameLength + 2);
        chunks.push('$' + placeholder);
      } else if (env === 'lokka' && /\.\.\.\s*$/.test(chunk)) {
        // This is Lokka-style fragment interpolation where you actually type the '...' yourself
        var _placeholder = strWithLen(nameLength + 3);
        chunks.push(_placeholder);
      } else if (env === 'relay') {
        // This is Relay-style fragment interpolation where you don't type '...'
        // Ellipsis cancels out extra characters
        var _placeholder2 = strWithLen(nameLength);
        chunks.push('...' + _placeholder2);
      } else {
        // Invalid interpolation
        context.report({
          node: value,
          message: 'Invalid interpolation - not a valid fragment or variable.'
        });
        throw new Error('Invalid interpolation');
      }
    }
  });

  return chunks.join('').trim();
}

function strWithLen(len) {
  // from http://stackoverflow.com/questions/14343844/create-a-string-of-variable-length-filled-with-a-repeated-character
  return new Array(len + 1).join('x');
}

function parseConfigAndResolveSchema() {
  var config = (0, _graphqlConfigParser.parse)();

  var wait = true;
  var schema = void 0,
      error = void 0;

  (0, _graphqlConfigParser.resolveSchema)(config).then(function (result) {
    schema = result;
    wait = false;
  }).catch(function (err) {
    error = err;
    wait = false;
  });

  // TODO find a cleaner way to do this
  (0, _deasync.loopWhile)(function () {
    return wait;
  });

  if (error) {
    throw error;
  }

  return schema.data;
}

exports.rules = rules;