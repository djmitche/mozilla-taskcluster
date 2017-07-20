import slugid from 'slugid';
import yaml from 'js-yaml';
import mustache from 'mustache';
import shell_quote from 'shell-quote';

// Regular expression matching: X days Y hours Z minutes
let timeExp = /^(\s*(\d+)\s*d(ays?)?)?(\s*(\d+)\s*h(ours?)?)?(\s*(\d+)\s*m(in(utes?)?)?)?\s*$/;

let Joi = require('joi');

/** Parse time string */
export function parseTime(str) {
  // Parse the string
  let match = timeExp.exec(str);
  if (!match) {
    throw new Error("String: '" + str + "' isn't a time expression");
  }
  // Return parsed values
  return {
    days:     parseInt(match[2] || 0),
    hours:    parseInt(match[5] || 0),
    minutes:  parseInt(match[8] || 0)
  };
};

/** Convert time object to relative Date object*/
export function relativeTime(time, to = new Date()) {
  return new Date(
    to.getTime()
    + time.days * 24 * 60 * 60 * 1000
    + time.hours     * 60 * 60 * 1000
    + time.minutes        * 60 * 1000
  );
};

/**
 * Instantiate a task-graph template from YAML string
 *
 * options:
 * {
 *   owner:         'user@exmaple.com',  // Owner emails
 *   source:        'http://...'         // Source file this was instantiated from
 *   revision:      '...',               // Revision hash string
 *   comment:       'try: ...',          // Latest commit comment
 *   project:       'try',               // Treeherder project name
 *   level          '2',                 // SCM Level
 *   revision_hash: '...',               // Revision hash for treeherder resultset
 *   pushlog_id:    '...',               // Pushlog id based on json-pushes
 *   url:           '...',               // Repository url
 * }
 *
 * In in addition to options provided above the following paramters is available
 * to templates:
 *  - `now` date-time string for now,
 *  - `from-now` modifier taking a relative date as 'X days Y hours Z minutes'
 *  - `as-slugid` modifier converting a label to a slugid
 *  - `shellquote` quotes its contents for a shell argument (including adding leading and trailing quotes)
 *
 */
export default function instantiate(template, options) {
  // Validate options
  Joi.assert(options, Joi.object({
    owner: Joi.string().required(),
    source: Joi.string().required(),
    revision: Joi.string().required(),
    project: Joi.string().required(),
    level: [Joi.number().required(), Joi.string().required()],
    revision_hash: Joi.string().required(),
    comment: Joi.string().default(""),
    pushlog_id: Joi.string().required(),
    url: Joi.string().required(),
    error: Joi.string(),
    pushdate: Joi.number()
  }));

  // Create label cache, so we provide the same slugids for the same label
  let labelsToSlugids = {};

  function fromNow() {
    return function(text, render) {
      return render(relativeTime(parseTime(text)).toJSON());
    }
  }

  function asSlugId() {
    return function(label, render) {
      let result = labelsToSlugids[label];
      if (result === undefined) {
        result = labelsToSlugids[label] = slugid.nice();
      }
      return render(result);
    }
  }

  // quote the contained text for passing to the shell; note that this includes
  // the leading and trailing " or ' characters, so they must not be included
  // in the template.
  function shellquote() {
    return function(text, render) {
      return shell_quote.quote([render(text)]);
    }
  }

  // make sure the owner looks like an email
  let owner = options.owner;
  if (owner.indexOf('@') === -1) {
    owner = owner + '@noreply.mozilla.org';
  }

  // Parameterize template
  template = mustache.render(template, {
    now: new Date().toJSON(),
    owner: owner,
    source: options.source,
    revision: options.revision,
    comment: options.comment,
    level: options.level,
    project: options.project,
    revision_hash: options.revision_hash,
    pushlog_id: options.pushlog_id,
    url: options.url,
    from_now: fromNow,
    as_slugid: asSlugId,
    pushdate: options.pushdate,
    shellquote
  });

  // Parse template
  let graph = yaml.safeLoad(template);

  return graph;
};
