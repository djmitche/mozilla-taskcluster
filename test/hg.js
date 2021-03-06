import _waitForPort from 'wait-for-port';
import temp from 'promised-temp';
import denodeify from 'denodeify';
import fsPath from 'path';
import fs from 'mz/fs';
import childProcess from 'child_process';
import Debug from 'debug';

// Name of the hg/pushlog service in docker-compose.yml
const SERVICE = 'pushlog';
const COMPOSE_DIR = __dirname;
const LOG_TEMPLATE = '{node} {author} {desc}\n';

const debug = Debug('hg');
const waitForPort = denodeify(_waitForPort);

// More robust error handling on top of normal exec...
async function exec(cmd, opts = {}) {
  let [err, stdout, stderr] = await new Promise((accept) => {
    childProcess.exec(cmd, opts, (err, stdout, stderr) => {
      accept([
        err,
        stdout,
        stderr
      ]);
    });
  });

  if (err) {
    throw new Error(`
      ${err.stack}

      stdout:
        ${stdout}

      stderr:
        ${stderr}
    `);
  }
  return [stdout, stderr];
}

class Hg {
  constructor(compose, containerId, url, path) {
    this.path = path;
    this.compose = compose;
    this.containerId = containerId;
    this.url = url;
  }

  async write(path, content=Date.now()) {
    let writePath = fsPath.join(this.path, path);
    let dir = fsPath.dirname(writePath);

    debug('write', writePath);
    await exec(`mkdir -p ${dir}`);
    await fs.writeFile(writePath, content);
  }

  async log() {
    let [stdout] = await exec(`hg log --template "${LOG_TEMPLATE}"`, {
      cwd: this.path
    });

    return stdout.trim().split('\n').map((v) => {
      let [node, user, desc] = v.split(' ');
      return { node, user, desc };
    });
  }

  async push() {
    debug('push');
    await exec(`hg push ${this.url}`, { cwd: this.path });
  }

  async commit(message='commit', user='user@example.com') {
    debug('commit', message, user);
    return exec(`hg commit -u "${user}" -A -m "${message}"`, {
      cwd: this.path,
      stdio: 'inherit'
    });
  }

  async destroy() {
    await exec(`rm -Rf ${this.path}`);
    await this.compose.destroy(this.containerId);
  }
}

export default async function(compose) {
  // Verify we have hg installed...
  try {
    await exec('which hg');
  } catch (e) {
    throw new Error(`
      These tests require hg to be installed on the host!
    `);
  }

  // First create an instance of the pushlog...
  let containerId = await compose.run(COMPOSE_DIR, SERVICE);
  let port = await compose.portById(containerId, 8000);
  let url = `http://${compose.host}:${port}`

  // Wait for the port to actually be available...
  await waitForPort(compose.host, port, {
    numRetries: 2000,
    retryInterval: 100
  });

  let path = temp.path();

  // XXX: Simply waiting for the socket does not seem to be enough retry clone
  // if it fails.
  let retries = 5;
  while (--retries) {
    try {
      await exec(`hg clone ${url} ${path}`);
      break;
    } catch (e) {
      if (!retries) throw e;
      // Ensure clone is not in partial or weird state...
      await exec(`rm -Rf ${path}`);
      await new Promise(accept => setTimeout(accept, 100));
    }
  }

  return new Hg(compose, containerId, url, path);
}
