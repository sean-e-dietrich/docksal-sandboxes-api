var http = require('http');
var async = require('async');
require('dotenv').load();

const PORT = process.env.PORT || 3000;
const NAME_LENGTH = process.env.NAME_LENGTH || 30;

var docksalDomain = process.env.DOCKSAL_DOMAIN;
var buildDirectory = process.env.BUILD_DIRECTORY;

/**
 * Github Event Listener
 */
var createGitHubHandler = require('github-webhook-handler');
var gitHubHandler = createGitHubHandler({ path: '/webhook', secret: process.env.GITHUB_SECRET });

/**
 * BitBucket Event Listener
 */
var createBitBucketHandler = require('bitbucket-webhook-handler');
var bitBucketHandler = createBitBucketHandler({ path: '/webhook' });

http.createServer(function (req, res) {
  // Bitbucket API
  if((req.headers['user-agent']).search('Bitbucket-Webhooks') != -1){
    bitBucketHandler(req, res, function(err) {

    });
  }
  // Github Webhook
  else if((req.headers['user-agent']).search('GitHub-Hookshot') != -1) {
    gitHubHandler(req, res, function (err) {

    })
  }
  // Send 404
  else {
    res.statusCode = 404;
    res.end('no such location');
  }
}).listen(PORT);

/**
 * GitHub Handler
 */
gitHubHandler
.on('error', function (err) {
  console.error('Error:', err.message)
})
.on('pull_request', function(event){
  console.log('Received a pull request event for %s',
    event.payload.repository.name
  );

  var provider = github_variables(event);
  event.provider = 'github';

  if(event.payload.action == 'closed'){
    deleteRemote(provider);
  } else {
    deployRemote(provider);
  }

});

/**
 * Delete the remote
 */
function deleteRemote(provider){
  // Delete the remote if available
  async.series([
    function (callback) {
      var cmd = "(cd " + provider.remoteBuildDirectory + " && fin rm -f) || true";
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      var cmd = "if [ -d " + provider.remoteBuildDirectory + " ]; then sudo rm -rf " + provider.remoteBuildDirectory + '; fi';
      ssh_cmd(cmd, callback);
    }
  ]);
}

function deployRemote(provider){
  var msg = 'Completed sandbox build for branch *' + provider.branch + '*: http://' + provider.domain;
  async.series([
    function (callback) {
      var cmd = "(cd " + provider.remoteBuildDirectory + " && fin rm -f) || true";
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      var cmd = "sudo rm -rf " + provider.remoteBuildDirectory + "; mkdir -p " + provider.remoteBuildDirectory;
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      var cmd = "cd " + provider.remoteBuildDirectory + " && git clone --branch='" + provider.branch + "' --depth 50 " + provider.repoURL + " . && git reset --hard " + provider.hash + " && ls -la";
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      var cmd = "cd " + provider.remoteBuildDirectory + " && echo COMPOSE_PROJECT_NAME=" + provider.compose_project_name + " | tee -a .docksal/docksal-local.env";
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      var cmd = "cd " + provider.remoteBuildDirectory + " && echo VIRTUAL_HOST=" + provider.domain + " | tee -a .docksal/docksal-local.env";
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      var cmd = "cd " + provider.remoteBuildDirectory + " && echo APACHE_BASIC_AUTH_USER=$HTTP_USER | tee -a .docksal/docksal-local.env";
      //ssh_cmd(cmd, callback);
      callback();
    },
    function (callback) {
      var cmd = "cd " + provider.remoteBuildDirectory + " && echo APACHE_BASIC_AUTH_PASS=$HTTP_PASS | tee -a .docksal/docksal-local.env";
      //ssh_cmd(cmd, callback);
      callback();
    },
    function (callback) {
      var cmd = "cd " + provider.remoteBuildDirectory + " && fin start";
      ssh_cmd(cmd, callback);
    },
    function (callback) {
      if(provider.provider == 'github') {
        github_post({
          owner: provider.repository.owner.login,
          repo: provider.repo,
          number: provider.pr.number,
          body: msg
        });
      }
      else if(provider.provider == 'bitbucket'){
        provider.message = msg;
        bitbucket_post(provider);
      }
      callback();
    },
    function (callback) {
      slack_post(msg);
      callback()
    }
  ]);
}

/**
 *
 * @param event
 * @returns {{repository, pr: *, branch, branchNameSafe: string, repo, repoNameSafe: string, domain: string, repoURL: *, compose_project_name: string, hash: string, remoteBuildDirectory: string}}
 */
function github_variables(event) {
  var repository = event.payload.repository;
  var pr = event.payload.pull_request;
  var branch = pr.head.ref;
  var branchNameSafe = name_safe(branch);
  var repo = repository.name;
  var repoNameSafe = name_safe(repo);
  var domain = branchNameSafe + '-' + repoNameSafe + '.' + docksalDomain;
  var repoURL = repository.git_url;
  var compose_project_name = branchNameSafe + "-" + repoNameSafe;
  var hash = pr.head.sha;

  var remoteBuildDirectory = buildDirectory + compose_project_name;

  return {
    repository: repository,
    pr: pr,
    branch: branch,
    branchNameSafe: branchNameSafe,
    repo: repo,
    repoNameSafe: repoNameSafe,
    domain: domain,
    repoURL: repoURL,
    compose_project_name: compose_project_name,
    hash: hash,
    remoteBuildDirectory: remoteBuildDirectory
  }
}

/**
 *
 * @param event
 * @returns {{repository, pr: *, branch, branchNameSafe: string, repo, repoNameSafe: string, domain: string, repoURL: string, compose_project_name: string, hash: string | AlgorithmIdentifier, remoteBuildDirectory: string}}
 */
function bitbucket_variables(event) {
  var repository = event.payload.repository;
  var owner = repository.owner.username;
  var pr = event.payload.pullrequest;
  var branch = pr.source.branch.name;
  var branchNameSafe = name_safe(branch);
  var repo = repository.name;
  var repoNameSafe = name_safe(repo);
  var domain = branchNameSafe + '-' + repoNameSafe + '.' + docksalDomain;
  var repoURL = "git@bitbucket.org:" + owner + "/" + repo + ".git";
  var compose_project_name = branchNameSafe + "-" + repoNameSafe;
  var hash = pr.source.commit.hash;

  var remoteBuildDirectory = buildDirectory + compose_project_name;
  var pullRequestId = pr.id;
  return {
    repository: repository,
    pr: pr,
    branch: branch,
    branchNameSafe: branchNameSafe,
    repo: repo,
    repoNameSafe: repoNameSafe,
    domain: domain,
    repoURL: repoURL,
    compose_project_name: compose_project_name,
    hash: hash,
    remoteBuildDirectory: remoteBuildDirectory,
    pullRequestId: pullRequestId,
    owner: owner
  }
}

/**
 * BitBucket Handler
 */
bitBucketHandler
.on('pullrequest:created', function(event) {
  var provider = bitbucket_variables(event);
  provider.provider = 'bitbucket';
  deployRemote(provider);
})
.on('pullrequest:updated', function(event) {
  var provider = bitbucket_variables(event);
  provider.provider = 'bitbucket';
  deployRemote(provider);
})
.on('pullrequest:approved', function(event) {
  var provider = bitbucket_variables(event);
  provider.provider = 'bitbucket';
  deleteRemote(provider);
})
.on('pullrequest:unapproved', function(event) {
  var provider = bitbucket_variables(event);
  provider.provider = 'bitbucket';
  deleteRemote(provider);
})
.on('pullrequest:rejected', function(event) {
  var provider = bitbucket_variables(event);
  provider.provider = 'bitbucket';
  deleteRemote(provider);
});

/**
 * Convert the provided argument into a safe name.
 * @param name
 * @returns {string}
 */
function name_safe(name) {
  var newName = name.toLowerCase();
  if(newName.length > NAME_LENGTH){
    var md5 = require('md5');
    newName = newName.substr(0, NAME_LENGTH) + (md5(newName)).substr(0,4);
  }
  return newName;
}

/**
 * Run ssh commands to remote server
 *
 * @param cmd
 * @param callback
 */
function ssh_cmd(cmd, callback) {
  var Client = require('ssh2').Client;
  var conn = new Client();
  console.log(cmd);
  conn.on('ready', function() {
    conn.exec(cmd, function(err, stream) {
      if (err) throw err;
      stream.on('close', function(code, signal) {
        //console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
        conn.end();
        callback();
      }).on('data', function(data) {
        //console.log('STDOUT: ' + data);
      }).stderr.on('data', function(data) {
        //console.log('STDERR: ' + data);
      });
    });
  }).connect({
    host: process.env.DOCKSAL_REMOTE_HOST,
    port: process.env.DOCKSAL_REMOTE_PORT,
    username: process.env.DOCKSAL_REMOTE_USER,
    privateKey: require('fs').readFileSync(process.env.DOCKSAL_REMOTE_KEY)
  });
}

/**
 * Send message to slack
 * @param msg
 */
function slack_post(msg) {
  const { IncomingWebhook } = require('@slack/client');
  const url = process.env.SLACK_URL;
  const webhook = new IncomingWebhook(url, {
    username: process.env.SLACK_USERNAME,
    iconEmoji: process.env.SLACK_ICON,
    channel: process.env.SLACK_CHANNEL
  });

  // Send simple text to the webhook channel
  webhook.send(msg, function(err, res) {
    if (err) {
      console.log('Error:', err);
    }
  });
}

/**
 * Post message to Github PR
 * @param comment
 */
function github_post(comment) {
  var GitHubApi = require('github');

  var github = new GitHubApi({
    timeout: 5000
  });

  // user token
  // @Todo: Otherways of authenticating
  github.authenticate({
    type: 'token',
    token: process.env.GITHUB_TOKEN
  });

  github.issues.createComment({
    'owner': comment.owner,
    'repo': comment.repo,
    'number': comment.number,
    'body': comment.body
  });
}

/**
 * Post message to Bitbucket API
 * @param comment
 */
function bitbucket_post(comment) {
  var bitbucket = require('bitbucket-api');
  var credentials = {username: process.env.BITBUCKET_USER, password: process.env.BITBUCKET_PASS};
  var client = bitbucket.createClient(credentials);
  var repository = client.getRepository({slug: comment.repo, owner: comment.owner}, function (err, repo) {
    if (err) throw err;
    repo.pullrequest(comment.pullRequestId).comments().create(comment.message, function(err, res){
      if (err) {
        console.log('Error:', err);
      }
    });
  });
}
