import {UrlToRepo} from './common';

var Signal = function() {
};

Signal.prototype = {
  listeners : [],

  tap: function(l) {
    // Make a copy of the listeners to avoid the all too common
    // subscribe-during-dispatch problem
    this.listeners = this.listeners.slice(0);
    this.listeners.push(l);
  },

  untap: function(l) {
    var ix = this.listeners.indexOf(l);
    if (ix == -1) {
      return;
    }

    // Make a copy of the listeners to avoid the all to common
    // unsubscribe-during-dispatch problem
    this.listeners = this.listeners.slice(0);
    this.listeners.splice(ix, 1);
  },

  raise: function() {
    var args = Array.prototype.slice.call(arguments, 0);
    this.listeners.forEach(function(l) {
      l.apply(this, args);
    });
  }
};

var css = function(el, n, v) {
  el.style.setProperty(n, v, '');
};

var FormatNumber = function(t) {
  var s = '' + (t|0),
      b = [];
  while (s.length > 0) {
    b.unshift(s.substring(s.length - 3, s.length));
    s = s.substring(0, s.length - 3);
  }
  return b.join(',');
};

var ParamsFromQueryString = function(qs, params) {
  params = params || {};

  if (!qs) {
    return params;
  }

  qs.substring(1).split('&').forEach(function(v) {
    var pair = v.split('=');
    if (pair.length != 2) {
      return;
    }

    // Handle classic '+' representation of spaces, such as is used
    // when Hound is set up in Chrome's Search Engine Manager settings
    pair[1] = pair[1].replace(/\+/g, ' ');

    params[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
  });


  return params;
};

var PreviousParamsURL;

var SearchParamsChanged = function() {
  var currentParamsURL = location.search;
  if (PreviousParamsURL !== currentParamsURL) {
    return true;
  }
  return false;
}

var ParamsFromUrl = function(params) {
  params = params || {
    q: '',
    i: 'nope',
    files: '',
    excludeFiles: '',
    repos: '*'
  };
  return ParamsFromQueryString(location.search, params);
};

var ParamValueToBool = function(v) {
  if(v == null) {
    return false;
  }

  v = v.toLowerCase();
  return v == 'fosho' || v == 'true' || v == '1';
};

var isAutoHideEnabled = function() {
  return ParamValueToBool(localStorage.getItem('autoHideAdvanced'));
};

var isIgnoreCasePrefEnabled = function() {
  return ParamValueToBool(localStorage.getItem('ignoreCase'));
};

/**
 * The data model for the UI is responsible for conducting searches and managing
 * all results.
 */
var Model = {
  // raised when a search begins
  willSearch: new Signal(),

  // raised when a search completes
  didSearch: new Signal(),

  willLoadMore: new Signal(),

  didLoadMore: new Signal(),

  didError: new Signal(),

  didLoadRepos: new Signal(),

  didDelete: new Signal(),

  didFilter: new Signal(),

  ValidRepos: function(repos) {
    var all = this.repos,
        seen = {};
    return repos.filter(function(repo) {
      var valid = all[repo] && !seen[repo];
      seen[repo] = true;
      return valid;
    });
  },

  RepoCount: function() {
    return Object.keys(this.repos).length;
  },

  Load: function() {
    var _this = this;
    var next = function() {
      var params = ParamsFromUrl();
      _this.didLoadRepos.raise(_this, _this.repos);

      if (params.q !== '') {
        _this.Search(params);
      }
    };

    if (typeof ModelData != 'undefined') {
      var data = JSON.parse(ModelData),
          repos = {};
      for (var name in data) {
        repos[name] = data[name];
      }
      this.repos = repos;
      next();
      return;
    }

    $.ajax({
      url: 'api/v1/repos',
      dataType: 'json',
      success: function(data) {
        _this.repos = data;
        next();
      },
      error: function(xhr, status, err) {
        // TODO(knorton): Fix these
        console.error(err);
      }
    });
  },

  Search: function(params) {
    this.willSearch.raise(this, params);
    var _this = this,
        startedAt = Date.now();
    PreviousParamsURL = location.search;
    params = $.extend({
      stats: 'fosho',
      repos: '*',
      rng: ':30',
    }, params);

    if (params.repos === '') {
      params.repos = '*';
    }

    _this.params = params;

    // An empty query is basically useless, so rather than
    // sending it to the server and having the server do work
    // to produce an error, we simply return empty results
    // immediately in the client.
    if (params.q == '') {
      _this.results = [];
      _this.resultsByRepo = {};
      _this.didSearch.raise(_this, _this.results);
      return;
    }

    $.ajax({
      url: 'api/v1/search',
      data: params,
      type: 'GET',
      dataType: 'json',
      success: function(data) {
        if (data.Error) {
          _this.didError.raise(_this, data.Error);
          return;
        }

        var matches = data.Results,
            stats = data.Stats,
            results = [];
        for (var repo in matches) {
          if (!matches[repo]) {
            continue;
          }

          var res = matches[repo];
          results.push({
            Repo: repo,
            Rev: res.Revision,
            Matches: res.Matches,
            FilesWithMatch: res.FilesWithMatch,
          });
        }

        results.sort(function(a, b) {
          return b.Matches.length - a.Matches.length || a.Repo.localeCompare(b.Repo);
        });

        var byRepo = {};
        results.forEach(function(res) {
          byRepo[res.Repo] = res;
        });

        _this.results = results;
        _this.resultsByRepo = byRepo;
        _this.stats = {
          Server: stats.Duration,
          Total: Date.now() - startedAt,
          Files: stats.FilesOpened
        };

        _this.didSearch.raise(_this, _this.results, _this.stats);
      },
      error: function(xhr, status, err) {
        _this.didError.raise(this, "The server broke down");
      }
    });
  },

  LoadMore: function(repo) {
    var _this = this,
        results = this.resultsByRepo[repo],
        numLoaded = results.Matches.length,
        numNeeded = results.FilesWithMatch - numLoaded,
        numToLoad = Math.min(2000, numNeeded),
        endAt = numNeeded == numToLoad ? '' : '' + numToLoad;

    _this.willLoadMore.raise(this, repo, numLoaded, numNeeded, numToLoad);

    var params = $.extend(this.params, {
      rng: numLoaded+':'+endAt,
      repos: repo
    });

    $.ajax({
      url: 'api/v1/search',
      data: params,
      type: 'GET',
      dataType: 'json',
      success: function(data) {
        if (data.Error) {
          _this.didError.raise(_this, data.Error);
          return;
        }

        var result = data.Results[repo];
        results.Matches = results.Matches.concat(result.Matches);
        // _this.didLoadMore.raise(_this, repo, _this.results);

        // load more, then filter
        const includeText = document.getElementById("includeText").value.trim();
        const excludeText = document.getElementById("excludeText").value.trim();
        Model.FilterFile(includeText, excludeText);
      },
      error: function(xhr, status, err) {
        _this.didError.raise(this, "The server broke down");
      }
    });
  },

  DeleteFile : function(filename, reponame) {
    var findIndex = function(array, string) {
      for (var i = 0; i < array.length; i ++) {
        if (array[i].Filename == string) {
          return i;
        }
      }
      return -1;
    };
    var _this = this,
      repo = this.resultsByRepo[reponame],
      matches = repo.Matches;
    var index = findIndex(matches, filename);
    if (index > -1) {
      matches.splice(index, 1);
      repo.FilesWithMatch--;
    }
    _this.didDelete.raise(_this, _this.results);
    //raise didDelete
  },

  DeleteRepo : function(reponame) {
    var _this = this,
      results = _this.results;
    var findIndex = function(array, string) {
      for (var i = 0; i < array.length; i ++) {
        if (array[i].Repo == string) {
          return i;
        }
      }
      return -1;
    };
    var index = findIndex(results, reponame);
    if (index > -1) {
      results.splice(index, 1);
    }
    _this.didDelete.raise(_this, _this.results);
  },

  FilterFile: function(includeText, excludeText) {
    const matcher = function(regex, file) {
      return file.Filename.match(regex) != null;
    }

    var filterHelper = function(filterText, results, inclusion) {
      filteredResults = results.map(repo => {
        var filteredRepo = Object.assign({}, repo);  // clone the repo object instead of refferencing
        filteredRepo.FilesWithMatch -= filteredRepo.Matches.length;
        if (inclusion) {
          filteredRepo.Matches = repo.Matches.filter(file => matcher(filterText, file))
        } else {
          filteredRepo.Matches = repo.Matches.filter(file => !matcher(filterText, file))
        }
        filteredRepo.FilesWithMatch += filteredRepo.Matches.length;
        return filteredRepo;
      });
      return filteredResults;
    };

    var _this = this,
      filteredResults = _this.results;

    if (includeText) {
      filteredResults = filterHelper(includeText, filteredResults, true);
    }
    if (excludeText) {
      filteredResults = filterHelper(excludeText, filteredResults, false);
    }
    _this.didFilter.raise(_this, filteredResults);
  },

  NameForRepo: function(repo) {
    var info = this.repos[repo];
    if (!info) {
      return repo;
    }

    var url = info.url,
        ax = url.lastIndexOf('/');
    if (ax  < 0) {
      return repo;
    }

    var name = url.substring(ax + 1).replace(/\.git$/, '');

    var bx = url.lastIndexOf('/', ax - 1);
    if (bx < 0) {
      return name;
    }

    return url.substring(bx + 1, ax) + ' / ' + name;
  },

  UrlToRepo: function(repo, path, line, rev) {
    return UrlToRepo(this.repos[repo], path, line, rev);
  }

};

var RepoOption = React.createClass({
  render: function() {
    return (
      <option value={this.props.value} selected={this.props.selected}>{this.props.value}</option>
    )
  }
});

var SearchBar = React.createClass({
  componentWillMount: function() {
    var _this = this;
    Model.didLoadRepos.tap(function(model, repos) {
      _this.setState({ allRepos: _this.alphaSortRepos(repos) });
    });
  },
  alphaSortRepos(repos) {
    return Object.keys(repos).sort(function (a, b) {return a.toLowerCase().localeCompare(b.toLowerCase());});
  },
  componentDidMount: function() {
    var q = this.refs.q.getDOMNode();

    // TODO(knorton): Can't set this in jsx
    q.setAttribute('autocomplete', 'off');

    this.setParams(this.props);

    if (this.hasAdvancedValues()) {
      this.showAdvanced();
    }

    q.focus();
  },
  getInitialState: function() {
    return {
      state: null,
      allRepos: [],
      repos: []
    };
  },
  queryGotKeydown: function(event) {
    switch (event.keyCode) {
    case 40:
      // this will cause advanced to expand if it is not expanded.
      this.refs.files.getDOMNode().focus();
      break;
    case 38:
      this.hideAdvanced();
      break;
    case 13:
      this.submitQuery();
      break;
    }
  },
  queryGotFocus: function(event) {
    if (!this.hasAdvancedValues()) {
      this.hideAdvanced();
    }
  },
  filesGotKeydown: function(event) {
    switch (event.keyCode) {
    case 38:
      // if advanced is empty, close it up.
      if (this.refs.files.getDOMNode().value.trim() === '') {
        this.hideAdvanced();
      }
      this.refs.q.getDOMNode().focus();
      break;
    case 13:
      this.submitQuery();
      break;
    }
  },
  filesGotFocus: function(event) {
    this.showAdvanced();
  },
  excludeFilesGotKeydown: function(event) {
    switch (event.keyCode) {
    case 38:
      // if advanced is empty, close it up.
      if (this.refs.excludeFiles.getDOMNode().value.trim() === '') {
        this.hideAdvanced();
      }
      this.refs.q.getDOMNode().focus();
      break;
    case 13:
      this.submitQuery();
      break;
    }
  },
  excludeFilesGotFocus: function(event) {
    this.showAdvanced();
  },
  submitQuery: function() {
    var isEnabled = isAutoHideEnabled();
    if(isEnabled) {
      this.hideAdvanced();
    }
    this.props.onSearchRequested(this.getParams());
  },
  getRegExp : function() {
    return new RegExp(
      this.refs.q.getDOMNode().value.trim(),
      this.refs.icase.getDOMNode().checked ? 'ig' : 'g');
  },
  getParams: function() {
    // selecting all repos is the same as not selecting any, so normalize the url
    // to have none.
    var repos = Model.ValidRepos(this.refs.repos.state.value);
    if (repos.length == Model.RepoCount()) {
      repos = [];
    }

    return {
      q : this.refs.q.getDOMNode().value.trim(),
      files : this.refs.files.getDOMNode().value.trim(),
      excludeFiles : this.refs.excludeFiles.getDOMNode().value.trim(),
      repos : repos.join(','),
      i: this.refs.icase.getDOMNode().checked ? 'fosho' : 'nope'
    };
  },
  setParams: function(params) {
    var q = this.refs.q.getDOMNode(),
        i = this.refs.icase.getDOMNode(),
        files = this.refs.files.getDOMNode(),
        excludeFiles = this.refs.excludeFiles.getDOMNode();

    q.value = params.q;
    i.checked = ParamValueToBool(params.i) || isIgnoreCasePrefEnabled();
    files.value = params.files;
    excludeFiles.value = params.excludeFiles;
  },
  hasAdvancedValues: function() {
    if(isIgnoreCasePrefEnabled()) {
      return this.refs.files.getDOMNode().value.trim() !== '' || this.refs.excludeFiles.getDOMNode().value.trim() !== '' || this.refs.repos.getDOMNode().value !== '';
    }else{
      return this.refs.files.getDOMNode().value.trim() !== '' || this.refs.excludeFiles.getDOMNode().value.trim() !== '' || this.refs.icase.getDOMNode().checked || this.refs.repos.getDOMNode().value !== '';
    }
  },
  showAdvanced: function() {
    var adv = this.refs.adv.getDOMNode(),
        ban = this.refs.ban.getDOMNode(),
        q = this.refs.q.getDOMNode(),
        files = this.refs.files.getDOMNode(),
        excludeFiles = this.refs.excludeFiles.getDOMNode();

    css(adv, 'height', 'auto');
    css(adv, 'padding', '10px 0');

    css(ban, 'max-height', '0');
    css(ban, 'opacity', '0');
  },
  hideAdvanced: function() {
    var adv = this.refs.adv.getDOMNode(),
        ban = this.refs.ban.getDOMNode(),
        q = this.refs.q.getDOMNode();

    css(adv, 'height', '0');
    css(adv, 'padding', '0');

    css(ban, 'max-height', '100px');
    css(ban, 'opacity', '1');

    q.focus();
  },
  ignoreCaseChanged: function() {
    var isChecked = this.refs.icase.getDOMNode().checked;
    this.setState({
      i: isChecked
    });
  },
  render: function() {
    var repoCount = this.state.allRepos.length,
        repoOptions = [],
        selected = {};

    this.state.repos.forEach(function(repo) {
      selected[repo] = true;
    });

    this.state.allRepos.forEach(function(repoName) {
      repoOptions.push(<RepoOption value={repoName} selected={selected[repoName]}/>);
    });

    var stats = this.state.stats;
    var statsView = '';
    if (stats) {
      statsView = (
        <span>
          <div className="stats-left">
            <a href="excluded_files.html"
              className="link-gray">
                Excluded Files
            </a>
          </div>
          <div className="stats-right">
            <div className="val">{FormatNumber(stats.Total)}ms total</div> /
            <div className="val">{FormatNumber(stats.Server)}ms server</div> /
            <div className="val">{FormatNumber(stats.Files)} files</div>
          </div>
        </span>
      );
    }

    return (
      <div id="input">
        <div id="ina">
          <input id="q"
              type="text"
              placeholder="Search by Regexp"
              ref="q"
              autocomplete="off"
              onKeyDown={this.queryGotKeydown}
              onFocus={this.queryGotFocus}/>
          <div className="button-add-on">
            <button id="dodat" onClick={this.submitQuery}></button>
          </div>
        </div>

        <div id="inb">
          <div id="adv" ref="adv">
            <span className="octicon octicon-chevron-up hide-adv" onClick={this.hideAdvanced}></span>
            <div className="field">
              <label htmlFor="files">Included File Path</label>
              <div className="field-input">
                <input type="text"
                    id="files"
                    placeholder="regexp"
                    ref="files"
                    onKeyDown={this.filesGotKeydown}
                    onFocus={this.filesGotFocus} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="excludeFiles">Exclude File Path</label>
              <div className="field-input">
                <input type="text"
                    id="excludeFiles"
                    placeholder="/regexp/"
                    ref="excludeFiles"
                    onKeyDown={this.excludeFilesGotKeydown}
                    onFocus={this.excludeFilesGotFocus} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="ignore-case">Ignore Case</label>
              <div className="field-input">
                <input type="checkbox" ref="icase" checked={this.state.i} onClick={this.ignoreCaseChanged} />
              </div>
            </div>
            <div className="field">
              <label className="multiselect_label" htmlFor="repos">Select Repo</label>
              <div className="field-input">
                <select id="repos" className="form-control multiselect" multiple={true} size={Math.min(16, repoCount)} ref="repos">
                  {repoOptions}
                </select>
              </div>
            </div>
          </div>
          <div className="ban" ref="ban" onClick={this.showAdvanced}>
            <em>Advanced:</em> ignore case, filter by path, stuff like that.
          </div>
        </div>
        <div className="stats">
          <div className="stats-left">
            <a href="/preferences.html" className="link-gray">Preferences</a>
          </div>
          {statsView}
        </div>
      </div>
    );
  }
});

/**
 * Take a list of matches and turn it into a simple list of lines.
 */
var MatchToLines = function(match) {
  var lines = [],
      base = match.LineNumber,
      nBefore = match.Before.length,
      nAfter = match.After.length;
  match.Before.forEach(function(line, index) {
    lines.push({
      Number : base - nBefore + index,
      Content: line,
      Match: false
    });
  });

  lines.push({
    Number: base,
    Content: match.Line,
    Match: true
  });

  match.After.forEach(function(line, index) {
    lines.push({
      Number: base + index + 1,
      Content: line,
      Match: false
    });
  });

  return lines;
};

/**
 * Take several lists of lines each representing a matching block and merge overlapping
 * blocks together. A good example of this is when you have a match on two consecutive
 * lines. We will merge those into a singular block.
 *
 * TODO(knorton): This code is a bit skanky. I wrote it while sleepy. It can surely be
 * made simpler.
 */
var CoalesceMatches = function(matches) {
  var blocks = matches.map(MatchToLines),
      res = [],
      current;
  // go through each block of lines and see if it overlaps
  // with the previous.
  for (var i = 0, n = blocks.length; i < n; i++) {
    var block = blocks[i],
        max = current ? current[current.length - 1].Number : -1;
    // if the first line in the block is before the last line in
    // current, we'll be merging.
    if (block[0].Number <= max) {
      block.forEach(function(line) {
        if (line.Number > max) {
          current.push(line);
        } else if (current && line.Match) {
          // we have to go back into current and make sure that matches
          // are properly marked.
          current[current.length - 1 - (max - line.Number)].Match = true;
        }
      });
    } else {
      if (current) {
        res.push(current);
      }
      current = block;
    }
  }

  if (current) {
    res.push(current);
  }

  return res;
};

/**
 * Use the DOM to safely htmlify some text.
 */
var EscapeHtml = function(text) {
  var e = EscapeHtml.e;
  e.textContent = text;
  return e.innerHTML;
};
EscapeHtml.e = document.createElement('div');

/**
 * Produce html for a line using the regexp to highlight matches.
 */
var ContentFor = function(line, regexp) {
  if (!line.Match) {
    return EscapeHtml(line.Content);
  }
  var content = line.Content,
      buffer = [];

  while (true) {
    regexp.lastIndex = 0;
    var m = regexp.exec(content);
    if (!m) {
      buffer.push(EscapeHtml(content));
      break;
    }

    buffer.push(EscapeHtml(content.substring(0, regexp.lastIndex - m[0].length)));
    buffer.push( '<em>' + EscapeHtml(m[0]) + '</em>');
    content = content.substring(regexp.lastIndex);
  }
  return buffer.join('');
};

var scrollTo = function(id) {
  event.preventDefault();
  var hash = '[id^=\"' + id + '\"]';
  $('html, body').animate({
    scrollTop: $(hash).offset().top
  }, 200, function(){
    window.location.hash = hash;
  });
};

var LineView = React.createClass({
  render: function(){
    var rev = this.props.rev,
        repo = this.props.repo,
        regexp = this.props.regexp,
        line = this.props.line,
        filename = this.props.filename;


      var content = ContentFor(line, regexp);
      return (
          <div className="line">
            <a href={Model.UrlToRepo(repo, filename, line.Number, rev)}
               className="lnum"
               target="_blank">{line.Number}</a>
            <span className="lval" dangerouslySetInnerHTML={{__html:content}} />
          </div>
      );
  }
});

var FilesView = React.createClass({

  onLoadMore: function(event) {
    Model.LoadMore(this.props.repo);
  },

  onDelete: function(filename) {
    document.activeElement.blur();
    Model.DeleteFile(filename, this.props.repo);
  },

  render: function() {
    var rev = this.props.rev,
        repo = this.props.repo,
        regexp = this.props.regexp,
        matches = this.props.matches,
        totalMatches = this.props.totalMatches;

    if (this.props.shouldHide) {
        return null;
    }

    const { onDelete } = this;

    var files = matches.map(function(match, index) {
      var filename = match.Filename,
          filenameId = repo + '/' + filename,
          blocks = CoalesceMatches(match.Matches);
      var matches = blocks.map(function(block) {
      var lines = block.map(function(line){
        return <LineView line={line} rev={rev} repo={repo} regexp={regexp} filename={filename} />
      });

        return (
            <div className="match">{lines}</div>
        );
      });

      return (
        <div className="file" id={filenameId}>
          <div className="title">
            <button className="stats stats-right" onClick={() => onDelete(filename)}>
              x
            </button>
            <a className="stats stats-right" onClick={() => scrollTo('anchor-' + filenameId)}>
              back
            </a>
            <a href={Model.UrlToRepo(repo, match.Filename, null, rev)}>
              {match.Filename}
            </a>
          </div>
          <div className="file-body">
            {matches}
          </div>
        </div>
      );
    });

    var more = '';
    if (matches.length < totalMatches) {
      more = (<button className="moar" onClick={this.onLoadMore}>Load all {totalMatches} matches in {Model.NameForRepo(repo)}</button>);
    }

    return (
      <div className="files">
      {files}
      {more}
      </div>
    );
  }
});
var TreeNode = React.createClass({
  onLoadMore: function(event) {
    Model.LoadMore(this.props.repo);
  },
  onDelete: function(filename) {
    Model.DeleteFile(filename, this.props.repo);
  },

  render: function() {
    var rev = this.props.rev,
        repo = this.props.repo,
        matches = this.props.matches,
        totalMatches = this.props.totalMatches;

    const { onDelete } = this;

    var files = matches.map(function(match, index) {
      const filename = match.Filename
      const filenameId = repo + '/' + filename
      return (
        <div>
          <div className="title" id = {"anchor-" + filenameId}>
            <button onClick={() => onDelete(filename)}>
              x
            </button>
            <a onClick={() => scrollTo(filenameId)}>
              {filename}
            </a>
          </div>
        </div>
      );
    });

    var more = '';
    if (matches.length < totalMatches) {
      more = (<button className="moar" onClick={this.onLoadMore}>Load all {totalMatches} matches in {Model.NameForRepo(repo)}</button>);
    }

    return (
      <div className="files">
      {files}
      {more}
      </div>
    );
  }
});
var TreeView = React.createClass({
  componentWillMount: function() {
    var _this = this;
    Model.willSearch.tap(function(model, params) {
      _this.setState({
        results: null,
        query: params.q
      });
    });
  },
  getInitialState: function() {
    return { results: null, hiddenReposMap: {} };
  },
  onDelete: function(reponame) {
    Model.DeleteRepo(reponame);
  },
  onFilterKeyUp: function() {
    const includeText = document.getElementById("includeText").value.trim();
    const excludeText = document.getElementById("excludeText").value.trim();
    Model.FilterFile(includeText, excludeText);
  },

  render: function() {
    if (this.state.results !== null && this.state.results.length !== 0) {
      const { onDelete } = this;
      var results = this.state.results || [];
      var filter = (
        <div id="inc" className="filter">
          <div className="title">
            <span className="name">Quick filter</span>
          </div>
          <div className="field">
            <label>Include</label>
            <div className="field-input">
              <input type="text" id="includeText" placeholder="file path" onKeyUp={this.onFilterKeyUp.bind(this)}/>
            </div>
            <label>Exclude</label>
            <div className="field-input">
              <input type="text" id="excludeText" placeholder="file path" onKeyUp={this.onFilterKeyUp.bind(this)}/>
            </div>
          </div>
        </div>
      );
      var repos = results.map(function(result, index) {
        var deleteLabel = "X";
        return (
          <div className="repo">
            <div className="title">
              <span className="name">{Model.NameForRepo(result.Repo)}</span>
              <span className="stats stats-right" onClick={() => onDelete(result.Repo)}>
                {{deleteLabel}}
              </span>
            </div>
            <TreeNode matches={result.Matches}
                rev={result.Rev}
                repo={result.Repo}
                totalMatches={result.FilesWithMatch} />
          </div>
        );
      });
    }
    return (
      <div className="tree-view">
        {filter}
        {repos}
      </div>
    );
  }
});

var ResultView = React.createClass({
  componentWillMount: function() {
    var _this = this;
    Model.willSearch.tap(function(model, params) {
      _this.setState({
        results: null,
        query: params.q
      });
    });
  },
  getInitialState: function() {
    return { results: null, hiddenReposMap: {} };
  },
  toggleRepoDisplay: function(repo) {
    var newHiddenReposMap = Object.assign({}, this.state.hiddenReposMap);
    newHiddenReposMap[repo] = !newHiddenReposMap[repo];
    this.setState({hiddenReposMap: newHiddenReposMap});
  },
  render: function() {
    if (this.state.error) {
      return (
        <div id="no-result" className="error">
          <strong>ERROR:</strong>{this.state.error}
        </div>
      );
    }

    if (this.state.results !== null && this.state.results.length === 0) {
      // TODO(knorton): We need something better here. :-(
      return (
        <div id="no-result">&ldquo;Nothing for you, Dawg.&rdquo;<div>0 results</div></div>
      );
    }

    if (this.state.results === null && this.state.query) {
      return (
        <div id="no-result"><img src="images/busy.gif" /><div>Searching...</div></div>
      );
    }

    var regexp = this.state.regexp,
        results = this.state.results || [];
    var temphiddenReposMap = this.state.hiddenReposMap;
    var temp = this.toggleRepoDisplay;
    var repos = results.map(function(result, index) {
      var shouldHide = temphiddenReposMap[result.Repo];
      var visibilityLabel = shouldHide ? "Show" : "Hide";
      return (
        <div className="repo">
          <div className="title">
            <span className="mega-octicon octicon-repo"></span>
            <span className="name">{Model.NameForRepo(result.Repo)}</span>
            <span className="stats stats-right" id="toggle"
                  onClick={temp.bind(this, result.Repo)}>{{visibilityLabel}}</span>
          </div>
          <FilesView matches={result.Matches}
              rev={result.Rev}
              repo={result.Repo}
              regexp={regexp}
              totalMatches={result.FilesWithMatch}
              shouldHide={shouldHide} />
        </div>
      );
    });
    return (
      <div id="result">{repos}</div>
    );
  }
});

var App = React.createClass({
  componentWillMount: function() {
    var params = ParamsFromUrl(),
        repos = (params.repos == '') ? [] : params.repos.split(',');

    this.setState({
      q: params.q,
      i: (params.i || isIgnoreCasePrefEnabled()),
      files: params.files,
      excludeFiles: params.excludeFiles,
      repos: repos
    });

    var _this = this;
    Model.didLoadRepos.tap(function(model, repos) {
      // If all repos are selected, don't show any selected.
      if (model.ValidRepos(_this.state.repos).length == model.RepoCount()) {
        _this.setState({repos: []});
      }
    });

    Model.didSearch.tap(function(model, results, stats) {
      _this.refs.searchBar.setState({
        stats: stats,
        repos: repos,
      });

      _this.refs.resultView.setState({
        results: results,
        regexp: _this.refs.searchBar.getRegExp(),
        error: null
      });

      _this.refs.treeView.setState({
        results: results,
        error:null
      });
    });

    Model.didLoadMore.tap(function(model, repo, results) {
      _this.refs.resultView.setState({
        results: results,
        regexp: _this.refs.searchBar.getRegExp(),
        error: null
      });

      _this.refs.treeView.setState({
        results: results,
        error:null
      });
    });

    Model.didError.tap(function(model, error) {
      _this.refs.resultView.setState({
        results: null,
        error: error
      });

      _this.refs.treeView.setState({
        results: null,
        error: error
      });
    });

    Model.didDelete.tap(function(model, results) {
      _this.refs.resultView.setState({
        results: results,
        regexp: _this.refs.searchBar.getRegExp(),
        error: null
      });

      _this.refs.treeView.setState({
        results: results,
        error:null
      });
    });

    Model.didFilter.tap(function(model, results) {
      _this.refs.resultView.setState({
        results: results,
        regexp: _this.refs.searchBar.getRegExp(),
        error: null
      });

      _this.refs.treeView.setState({
        results: results,
        error: null
      });
    });

    window.addEventListener('popstate', function(e) {
      // Since we are jumping around with anchor tag, the url will be modified and popstate event will be triggered to redo the search.
      // Adding this condition so that as long as the search params do not change, don't perform the search again
      if (SearchParamsChanged()) {
        var params = ParamsFromUrl();
        _this.refs.searchBar.setParams(params);
        Model.Search(params);
      }
    });
  },
  onSearchRequested: function(params) {
    this.updateHistory(params);
    Model.Search(this.refs.searchBar.getParams());
  },
  updateHistory: function(params) {
    var path = location.pathname +
      '?q=' + encodeURIComponent(params.q) +
      '&i=' + encodeURIComponent(params.i) +
      '&files=' + encodeURIComponent(params.files) +
      '&excludeFiles=' + encodeURIComponent(params.excludeFiles) +
      '&repos=' + params.repos;
    history.pushState({path:path}, '', path);
  },
  initPreferences: function() {
    var ignoreCase = localStorage.getItem('ignoreCase');
    var hideAdvanced = localStorage.getItem('autoHideAdvanced');

    if(ignoreCase == null) {
      localStorage.setItem('ignoreCase', false);
    }
    if(hideAdvanced == null) {
      localStorage.setItem('autoHideAdvanced', false);
    }
  },
  render: function() {
    this.initPreferences();

    return (
      <div>
        <SearchBar ref="searchBar"
            q={this.state.q}
            i={this.state.i}
            files={this.state.files}
            excludeFiles={this.state.excludeFiles}
            repos={this.state.repos}
            onSearchRequested={this.onSearchRequested} />
        <TreeView ref="treeView" q={this.state.q} />
        <ResultView ref="resultView" q={this.state.q} />
      </div>
    );
  }
});

React.renderComponent(
  <App />,
  document.getElementById('root')
);
Model.Load();