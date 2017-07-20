import path from 'path';
import _ from 'lodash';
import assert from 'assert';
import slugid from 'slugid';
import eventToPromise from 'event-to-promise';
import waitFor from '../wait_for';
import testSetup from '../monitor';
import taskcluster from 'taskcluster-client';
import fs from 'mz/fs';
import yaml from 'js-yaml';
import TaskclusterGraphJob from '../../src/jobs/taskcluster_graph';

suite('TaskclusterGraphJob.work', function() {
  let defaultConfig;

  // load the default config so we can utilize some of its values
  setup(async () => {
    let resolved = path.resolve(__dirname + '/../../src/config/default.yml');
    let content = await fs.readFile(resolved, 'utf8');
    defaultConfig = yaml.safeLoad(content);
  });

  let makeJob = ({graphs}) => {
    let config = {
      taskcluster: {
        credentials: {
          clientId: 'test',
          accessToken: 'test',
        },
      },
      try: {
        tcYamlUrl: defaultConfig.try.tcYamlUrl,
        defaultUrl: defaultConfig.try.defaultUrl,
        errorTask: defaultConfig.try.errorTask,
        projects:{
          mine: {
            url: "{{{host}}}/myrepo",
            level: 7,
            scopes: ['assume:repo:hg.mozilla.org/myrepo'],
          },
        },
      },
    };

    let runtime = {
      pushlog: {
        getOne: async (url, pushlogId) => {
          assert.equal(url, 'https://hg.mozilla.org/myrepo');
          assert.equal(pushlogId, 9999);
          return {
            changesets: [
              {desc: 'message!', node: "6fec4855b5345eb63fef57089e61829b88f5f4eb"},
            ],
            id: 9999,
            user: 'ffxbld',
          };
        },
      },
    };

    let job = new TaskclusterGraphJob({config, runtime});

    job.fetchGraph = async function(url) {
      let rv = graphs[url];
      assert(rv, `fake graph for ${url} not defined`);
      if (typeof rv !== 'string') {
        rv = JSON.stringify(rv);
      }
      return rv;
    };

    return job;
  };

  let makeQueue = () => {
    let created = [];
    let queue = {
      created,
      createTask: async (taskId, definition) => {
        created.push({taskId, definition});
      },
    };
    return queue;
  };

  // test that work() calls scheduleTaskGroup correctly..
  test('work', async function() {
    let job = makeJob({graphs: {
      "https://hg.mozilla.org/myrepo/raw-file/6fec4855b5345eb63fef57089e61829b88f5f4eb/.taskcluster.yml": {
        version: 0,
        tasks: [],
      },
    }});

    job.scheduleTaskGroup = (queue, alias, graphText, templateVariables, scopes, errorGraphUrl) => {
      assert.equal(alias, 'mine');
      assert.equal(JSON.parse(graphText).version, 0);
      assert.equal(templateVariables.owner, 'ffxbld');
      assert.equal(scopes[0], "assume:repo:hg.mozilla.org/myrepo");
      assert.equal(scopes[1], "queue:route:notify.email.ffxbld.*");
    };

    await job.work({data: {
      revision_hash: 'abcdef',
      pushref: {id: 9999},
      repo: {alias: 'mine', url: 'https://hg.mozilla.org/myrepo'},
    }});
  });

  let runScheduleTaskGroup = async function(template) {
    let queue = makeQueue();
    let job = makeJob({graphs: {}});

    let templateVariables = {
      owner: 'ffxbld',
      revision: '6fec4855b5345eb63fef57089e61829b88f5f4eb',
      project: 'mine',
      level: 7,
      revision_hash: '6fec4855b5345eb63fef57089e61829b88f5f4eb',
      comment: 'comment with stuff in it',
      pushlog_id: '9999',
      url: 'https://hg.mozilla.org/myrepo',
      pushdate: '1499805383',
      source: 'https://hg.mozilla.org/myrepo/raw-file/6fec4855b5345eb63fef57089e61829b88f5f4eb/.taskcluster.yml',
    };
    if (typeof template !== 'string') {
      template = JSON.stringify(template);
    }
    await job.scheduleTaskGroup(queue, 'mine', template, templateVariables, [], job.config.try.errorTask);
    return queue.created;
  };

  test('scheduleTaskGroup version 0', async function() {
    // this is a stripped-down version of the old version-0 .taskcluster.yml.  Note that
    // this is not valid YAML!
    let template = `
---
version: 0
scopes: []
tasks:
- taskId: '{{#as_slugid}}decision task{{/as_slugid}}'  # note that this is ignored
  task:
    created: '{{now}}'
    deadline: '{{#from_now}}1 day{{/from_now}}'
    expires: '{{#from_now}}365 day{{/from_now}}'
    metadata: {source: '{{{source}}}'}
    payload:
      cache: {'level-{{level}}-checkouts': /home/worker/checkouts}
      command:
        - bash
        - >
          --pushlog-id='{{pushlog_id}}'
          --pushdate='{{pushdate}}'
          --project='{{project}}'
          --message={{#shellquote}}{{{comment}}}{{/shellquote}}
          --owner='{{owner}}'
          --level='{{level}}'
          --head-repository='{{{url}}}'
          --head-rev='{{revision}}'
      env: {GECKO_HEAD_REPOSITORY: '{{{url}}}', GECKO_HEAD_REV: '{{revision}}'}
    routes: ['tc-treeherder-stage.v2.{{project}}.{{revision}}.{{pushlog_id}}']
    tags: {createdForUser: '{{owner}}'}`;

    let created = await runScheduleTaskGroup(template);
    assert.equal(created.length, 1);
    let taskId = created[0].taskId;
    created = created[0].definition;
    assert.deepEqual(_.pick(created, ['metadata', 'tags', 'routes', 'payload', 'scopes', 'schedulerId']), {
      "metadata": {
        "source": "https://hg.mozilla.org/myrepo/raw-file/6fec4855b5345eb63fef57089e61829b88f5f4eb/.taskcluster.yml"
      },
      "tags": {
        "createdForUser": "ffxbld@noreply.mozilla.org"
      },
      "routes": [
        "tc-treeherder-stage.v2.mine.6fec4855b5345eb63fef57089e61829b88f5f4eb.9999"
      ],
      "payload": {
        "cache": {
          "level-7-checkouts": "/home/worker/checkouts"
        },
        "command": ["bash", [
          "--pushlog-id='9999'",
          "--pushdate='1499805383'",
          "--project='mine'",
          "--message='comment with stuff in it'",
          "--owner='ffxbld@noreply.mozilla.org'",
          "--level='7'",
          "--head-repository='https://hg.mozilla.org/myrepo'",
          "--head-rev='6fec4855b5345eb63fef57089e61829b88f5f4eb'"
        ].join(' ') + '\n'], // pesky newline..
        "env": {
          "GECKO_HEAD_REPOSITORY": "https://hg.mozilla.org/myrepo",
          "GECKO_HEAD_REV": "6fec4855b5345eb63fef57089e61829b88f5f4eb"
        }
      },
      "scopes": [],
      "schedulerId": "gecko-level-7",
    });
    // created should be in the last 5s..
    assert(new Date() - new Date(created.created) < 5000);
    // for a decision task, taskGroupId = taskId
    assert.equal(created.taskGroupId, taskId);
  });

  test('scheduleTaskGroup version 1', async function() {
    let template = JSON.stringify({
      version: 1,
      tasks: {
        $let: {ownerEmail: {$if: '"@" in push.owner', then: '${push.owner}', else: '${push.owner}@noreply.mozilla.org'}},
        in: [
          {
            taskId: {$eval: 'as_slugid("decision")'},
            taskGroupId: {$eval: 'as_slugid("decision")'},
            created: {$fromNow: ''},
            deadline: {$fromNow: '1 day'},
            expires: {$fromNow: '1 year'},
            metadata: {source: '${repo.url}/raw-file/${push.revision}/.taskcluster.yml'},
            payload: {
              cache: {'level-${repo.level}-checkouts': '/home/worker/checkouts'},
              command: ['bash', [
                  "--pushlog-id='${push.pushlog_id}'",
                  "--pushdate='${push.pushdate}'",
                  "--project='${repo.project}'",
                  "--message=$GECKO_COMMIT_MSG",
                  "--owner='${ownerEmail}'",
                  "--level='${repo.level}'",
                  "--head-repository='${repo.url}'",
                  "--head-rev='${push.revision}'",
              ].join(' ')],
              env: {
                GECKO_COMMIT_MSG: '${push.comment}',
              },
            },
            routes: ['tc-treeherder-stage.v2.${repo.project}.${push.revision}.${push.pushlog_id}'],
            tags: {createdForUser: '${ownerEmail}'},
            scopes: ['all-the-things'],
            schedulerId: "gecko-level-7",
          },
        ],
      },
    });

    let created = await runScheduleTaskGroup(template);
    assert.equal(created.length, 1);
    let taskId = created[0].taskId;
    created = created[0].definition;
    assert.deepEqual(_.pick(created, ['metadata', 'tags', 'routes', 'payload', 'scopes', 'schedulerId']), {
      metadata: {
        "source": "https://hg.mozilla.org/myrepo/raw-file/6fec4855b5345eb63fef57089e61829b88f5f4eb/.taskcluster.yml"
      },
      tags: {
        "createdForUser": "ffxbld@noreply.mozilla.org"
      },
      routes: [
        "tc-treeherder-stage.v2.mine.6fec4855b5345eb63fef57089e61829b88f5f4eb.9999"
      ],
      payload: {
        cache: {
          "level-7-checkouts": "/home/worker/checkouts"
        },
        command: ["bash", [
          "--pushlog-id='9999'",
          "--pushdate='1499805383'",
          "--project='mine'",
          "--message=$GECKO_COMMIT_MSG",
          "--owner='ffxbld@noreply.mozilla.org'",
          "--level='7'",
          "--head-repository='https://hg.mozilla.org/myrepo'",
          "--head-rev='6fec4855b5345eb63fef57089e61829b88f5f4eb'"
        ].join(' ')],
        env: {
          "GECKO_COMMIT_MSG": "comment with stuff in it",
        }
      },
      scopes: ['all-the-things'],
      schedulerId: "gecko-level-7",
    });
    // created should be in the last 5s..
    assert(new Date() - new Date(created.created) < 5000);
    // for a decision task, taskGroupId = taskId
    assert.equal(created.taskGroupId, taskId);
  });

  test('scheduleTaskGroup invalid', async function() {
    let template = 'version: 0\nIN-VALID: true';
    let created = await runScheduleTaskGroup(template);
    assert.equal(created.length, 1);
    let taskId = created[0].taskId;
    created = created[0].definition;
    // this should result in the error task
    assert.deepEqual(_.pick(created, ['metadata', 'tags', 'routes', 'payload', 'scopes', 'schedulerId']), {
      metadata: {
        description: "Error creating decision task...\n",
        name: "Error message...",
        owner: "ffxbld@noreply.mozilla.org",
        source: "https://hg.mozilla.org/myrepo/raw-file/6fec4855b5345eb63fef57089e61829b88f5f4eb/.taskcluster.yml",
      },
      payload: {
        env: {
          ERROR_MSG: "TypeError: Cannot read property 'Symbol(Symbol.iterator)' of undefined"
        },
        command: [
          "/bin/bash",
          "-c",
          "echo \"[taskcluster:error] ERROR Generating task graph (no tests/build will be created)\"; echo \"[taskcluster:error] $ERROR_MSG\"; exit 1\n",
        ],
        "env": {
          "ERROR_MSG": "TypeError: Cannot read property 'map' of undefined",
        },
        "image": "quay.io/mozilla/decision:0.0.3",
        "maxRunTime": 500,
      },
      "routes": [
        "tc-treeherder-stage.mine.6fec4855b5345eb63fef57089e61829b88f5f4eb",
        "tc-treeherder.mine.6fec4855b5345eb63fef57089e61829b88f5f4eb",
      ],
      schedulerId: "gecko-level-7",
      scopes: [],
    });
  });
});

// XXX: This value comes from configs we should fetch it from there somehow.
const GRAPH_PATH = 'testing/taskcluster/tasks/decision/try.yml'

// these tests don't work anymore..
suite.skip('jobs/taskcluster_graph', function() {
  let monitorSetup = testSetup('workers.js');

  async function createErrorYaml(route) {
    let content = yaml.safeLoad(
      await fs.readFile(__dirname + '/../fixtures/try/error.yml')
    );

    content.scopes = content.scopes || [];
    content.scopes.push('queue:route:' + route);
    content.tasks[0].task.routes.push(route);

    return yaml.safeDump(content);
  }

  test('update after a push', async function() {
    let graph =
      await fs.readFile(__dirname + '/../fixtures/try/decision.yml', 'utf8');

    // Write the first commit... Note that the graph is added here but it does
    // not matter where it is added...
    await monitorSetup.hg.write(GRAPH_PATH, graph);
    await monitorSetup.hg.commit();

    // Write the second commit with the try flags...
    await monitorSetup.hg.write('README', 'bla')
    await monitorSetup.hg.commit('try: desc +tc');

    // Fetch the cset which contains our push...
    let hgLog = await monitorSetup.hg.log();
    let lastChangeset = hgLog[0].node;

    let schedulerEvents = new taskcluster.SchedulerEvents();
    let queueEvents = new taskcluster.QueueEvents();

    // Setup the listeners prior to the push to ensure we don't have any races.
    await this.pulse.connect();
    let route = `route.test.try.${lastChangeset}`
    this.pulse.bind(queueEvents.taskPending(route));

    // Actually push our changes...
    await monitorSetup.hg.push();

    await this.pulse.resume();
    // Consume the queue now that the event has been sent...
    let [ message ] = await Promise.all([
      eventToPromise(this.pulse, 'message'),
      this.pulse.resume()
    ]);

    let queue = new taskcluster.Queue();
    let task = await queue.task(message.payload.status.taskId);
    assert.equal(task.routes[0], route.replace('route.', ''));
    assert(task.extra.comment, 'try: desc +tc');
  });

  test('multi-line try commit', async function() {
    let graph =
      await fs.readFile(__dirname + '/../fixtures/try/decision.yml', 'utf8');

    // Write the first commit... Note that the graph is added here but it does
    // not matter where it is added...
    await monitorSetup.hg.write(GRAPH_PATH, graph);
    await monitorSetup.hg.commit();

    // Write the second commit with the try flags...
    await monitorSetup.hg.write('README', 'bla')
    await monitorSetup.hg.commit('The xfoo wow\ntry: desc +tc\nwootbar');

    // Fetch the cset which contains our push...
    let hgLog = await monitorSetup.hg.log();
    let lastChangeset = hgLog[0].node;

    let schedulerEvents = new taskcluster.SchedulerEvents();
    let queueEvents = new taskcluster.QueueEvents();

    // Setup the listeners prior to the push to ensure we don't have any races.
    await this.pulse.connect();
    let route = `route.test.try.${lastChangeset}`
    this.pulse.bind(queueEvents.taskPending(route));

    // Actually push our changes...
    await monitorSetup.hg.push();

    await this.pulse.resume();
    // Consume the queue now that the event has been sent...
    let [ message ] = await Promise.all([
      eventToPromise(this.pulse, 'message'),
      this.pulse.resume()
    ]);

    let queue = new taskcluster.Queue();
    let task = await queue.task(message.payload.status.taskId);
    assert(task.extra.comment, 'try: desc +tc');
  });

  test('error creating task graph', async function() {
    // Invalid yaml...
    let graph = ':\n:';
    let route = `test.try.${slugid.nice()}`

    await monitorSetup.hg.write('error.yml', await createErrorYaml(route));
    await monitorSetup.hg.write(GRAPH_PATH, graph);
    await monitorSetup.hg.write('README', 'bla')
    await monitorSetup.hg.commit('try: desc +tc');

    let schedulerEvents = new taskcluster.SchedulerEvents();
    let queueEvents = new taskcluster.QueueEvents();

    // Setup the listeners prior to the push to ensure we don't have any races.
    await this.pulse.connect();
    this.pulse.bind(queueEvents.taskPending('route.' + route));

    // Actually push our changes...
    await monitorSetup.hg.push();

    await this.pulse.resume();
    // Consume the queue now that the event has been sent...
    let [ message ] = await Promise.all([
      eventToPromise(this.pulse, 'message'),
      this.pulse.resume()
    ]);

    let queue = new taskcluster.Queue();
    let task = await queue.task(message.payload.status.taskId);
    assert.ok(task.metadata.name.indexOf('Error') !== -1, 'is error task');
  });
});
