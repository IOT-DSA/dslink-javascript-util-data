// works for both node and browser, ES5+Promises+ supported
(function(){

// ### EVENT EMITTER ###
// uses node.js's emitter if possible, lightweight fallback for browser
var EventEmitter = (function() {
  // browser, add script w/ promise
  try {
    if (window && document) {
      // same one found at
      // https://github.com/dglux/dgframe
      function EventEmitter() {
        this._listeners = {};
      }

      // this is really dirty, but it prevents more try/catch
      EventEmitter._isBrowser = true;

      EventEmitter.prototype = {
        emit: function(name) {
          var args = [];
          var count = 1;
          var length = arguments.length;

          for (; count < length; count++) {
            args.push(arguments[count]);
          }

          (this._listeners[name] || []).forEach(function(f) {
            f.apply(this, args);
          }, this);

          return this;
        },
        on: function(name, listener) {
          if (!this._listeners[name])
            this._listeners[name] = [];
          this._listeners[name].push(listener);

          var emitter = Object.create(this);
          var removeListener = emitter.removeListener;
          emitter.removeListener = function(n, l) {
            if (!n && !l) {
              removeListener.call(this, name, listener);
              return;
            }
            removeListener.call(this, n, l);
          };
          return emitter;
        },
        once: function(name, listener) {
          var actual = function() {
            this.removeListener(name, actual);
            listener();
          }.bind(this);

          this.on(name, actual);
        },
        removeListener: function(name, listener) {
          if (!this._listeners[name] || this._listeners[name].indexOf(listener) === -1)
            return null;
          return this._listeners[name].splice(this._listeners[name].indexOf(listener), 1);
        }
      };

      return EventEmitter;
    }
  } catch(e) {}

  // node.js, blank resolved promise
  try {
    if (global && require) {
      return require("events").EventEmitter;
    }
  } catch(e) {}

  throw new Error("Unsupported environment for dslink-javascript-util-data, not running on a browser or node.js?");
})();

// ### isBrowser ###
// it checks the value set on the browser implementation of EventEmitter
// to prevent yet another try/catch loop

var isBrowser = EventEmitter._isBrowser;

// ### withDS ####
// Promise that waits for window.DS on browser, dslink package on node.js

// : Promise
var dsPromise = (function() {
  // browser, add script w/ promise
  try {
    if (window && document) {
      return new Promise(function(resolve, reject) {
        window.addEventListener("load", function() {
          if (!window.DS) {
            reject(new Error("Failed to load dslink-javascript-util-data, you must have the JavaScript DSA SDK loaded on the page!"))
          }
          resolve(window.DS);
        });
      });
    }
  } catch(e) {}

  // node.js, blank resolved promise
  try {
    if (global && require) {
      return Promise.resolve(require("dslink"));
    }
  } catch(e) {}

  throw new Error("Unsupported environment for dslink-javascript-util-data, not running on a browser or node.js?");
})();

function init() {

  // ### DATA TREE ###

  // access both an array of values and key-value manipulation at the same time
  // best way I could quickly come up with
  function InternalMapLike() {
    this.keys = [];
    this.values = [];
  }

  InternalMapLike.prototype = Object.create(null);

  InternalMapLike.prototype.set = function(key, value) {
    var oldIndex = this.keys.indexOf(key);
    if (oldIndex > -1) {
      this.values[oldIndex] = value;
      return value;
    }

    this.keys.push(key);
    this.values.push(value);
    return value;
  }

  InternalMapLike.prototype.get = function(key) {
    var index = this.keys.indexOf(key);
    if (index < 0) {
      return null;
    }
    return this.values[index];
  };

  InternalMapLike.prototype.remove = function(key) {
    var index = this.keys.indexOf(value);

    if (index < 0) {
      return value;
    }

    this.keys.splice(index, 1);
    this.values.splice(index, 1);
    return value;
  };

  InternalMapLike.prototype.deleteStartingWith = function(k) {
    ([].concat(this.keys)).forEach(function(key) {
      if (key === k || key.indexOf(k + "/") === 0) {
        this.remove(key);
      }
    }.bind(this));
  }

  /*
    OPTIONS:

    prefix (string, default "util-data-[node,web]"): Name for the abstracted DSLink, trailing - is added automatically.
    token (string): Use a custom token for connecting to the broker (will be generated & stored otherwise).
    subscribeOnList (bool, default true): If any values found in list() should be automatically subscribed to.
   */
  function DataTree(url, obj) {
    EventEmitter.call(this);
    this.url = url;

    obj = obj || {};
    this.prefix = obj.prefix || ("util-data-" + (isBrowser ? "web" : "node"));
    this.subscribeOnList = obj.subscribeOnList || true;

    // don't put this in the actual class instance
    var token = obj.token;

    this._deepListCache = {};
    this.isConnected = false;
    this._streams = [];

    this.rootNode = null;
    this._map = new InternalMapLike();

    this._withDS(function(DS) {
      this._link = new DS.LinkProvider(this.url, this.prefix + "-", {
        token: token,
        isRequester: true,
        isResponder: true
      });
    });
  }

  DataTree.prototype = Object.create(EventEmitter.prototype);

  // simple helper, mostly used to not forget a call to bind (this normally wouldn't be an issue in ES6+)
  DataTree.prototype._withDS = function(cb) {
    dsPromise.then(cb.bind(this));
  };

  DataTree.prototype._getType = function(remoteNode) {
    if (remoteNode.configs.$is === "dsa/broker") {
      return "broker";
    }

    if (remoteNode.configs.$type) {
      return "value";
    }

    if (remoteNode.configs.$invokable) {
      return "action";
    }

    return "node";
  };

  DataTree.prototype._update = function() {
    this.rootNode = this._map.get("/");
    this.emit("data", this._map.values);
  };

  DataTree.prototype.subscribe = function(path) {
    return dsPromise.then(function(DS) {
      var node = this._map.get(path);
      if (!node || node.type !== "value" || node.lastUpdated) {
        return;
      }

      node.value = null;
      node.lastUpdated = Date.now();

      // start subscribing
      var subscribeListener = function(update) {
        var unode = this._map.get(path);

        unode.value = update.value;
        unode.lastUpdated = Date.parse(update.ts);

        this._update();
      }.bind(this);

      this._streams.push(this._requester.subscribe(path, subscribeListener));

      // stop subscribing
      var deleteListener = function(deletedPath) {
        if (path !== deletedPath) {
          return;
        }

        // stop subscribing
        this.removeListener("delete", deleteListener);
      }.bind(this);

      this.on("delete", deleteListener);
    }.bind(this));
  };

  DataTree.prototype._streamData = function(path, parentPath, stream, resolve, recursive) {
      this._streams.push(stream);

      var isInitial = true;
      this._deepListCache[path] = recursive;
      stream.on("data", function(update) {
        if (!update.node) {
          return;
        }        

        var oldNode = this._map.get(path);
        var nodeName = path.split("/");
        nodeName = nodeName[nodeName.length - 1].trim();
        if (!nodeName) {
          nodeName = "/";
        }

        if (!!parentPath && !this._map.get(parentPath)) {
          return;
        }

        var promises = [];
        var addChild = function(node, name) {
          node.childrenNames.push(name);
          if (!this._deepListCache[path]) {
            return;
          }

          var childPathPrefix = path == "/" ? "/" : (path + "/");

          // trigger update
          promises.push(this.list(childPathPrefix + name, false));
        }.bind(this);

        // everything has changed
        if (update.changes === null || !oldNode) {
          oldNode = oldNode || {};
          var node = {
            type: this._getType(update.node),
            path: path,
            name: nodeName,
            configs: update.node.configs,
            parent: oldNode.parent || this._map.get(parentPath),
            children: [],
            childrenNames: Object.keys(update.node.children)
          };

          if (oldNode.parent) {
            oldNode.parent.children.remove(oldNode);
            oldNode.parent.children.push(node);
          } else if (parentPath != null) {
            node.parent.children.push(node);
          }

          if (oldNode.children && oldNode.children.length) {
            oldNode.children.forEach(function(child) {
              child.parent = node;
            });
          }

          // add children nodes
          Object.keys(update.node.children).forEach(function(child) {
            addChild(node, child);
          });

          this._map.set(path, node);

          if (node.type === "value" && this.subscribeOnList) {
            this.subscribe(path);
          }
        } else {
          if (!oldNode) {
            return;
          }

          // base updates on changes
          oldNode.type = this._getType(update.node);
          oldNode.name = nodeName;
          oldNode.configs = update.node.configs;
          var children = oldNode.childrenNames = Object.keys(update.node.children);

          // create any new nodes
          var oldChildren = oldNode.children.map(function(child) {
            return child.name;
          });

          children.forEach(function(childKey) {
            if (oldChildren.indexOf(childKey) < 0) {
              // add child node
              addChild(oldNode, childKey);
            }
          }.bind(this));

          // delete any old nodes
          if (this._deepListCache[path]) {
            oldChildren.forEach(function(childKey) {
              if (children.indexOf(childKey) < 0) {
                // remove old node
                oldNode.children.splice(oldChildren.indexOf(childKey), 1);
                var childPathPrefix = path == "/" ? "/" : (path + "/");
                this._map.deleteStartingWith(childPathPrefix + childKey);
                this.emit("delete", childPathPrefix + childKey);
              }
            }.bind(this));
          }
        }

        if (promises.length) {
          Promise.all(promises)
            .then(this._update.bind(this))
            .catch(this._update.bind(this));
        }

        this._update();

        if (isInitial) {
          isInitial = false;
          resolve();
        }
      }.bind(this));

      stream.on("close", function() {
        this._map.remove(path);
        this._streams.remove(stream);
      }.bind(this));
  };

  DataTree.prototype.connect = function() {
    // so this isn't called before this._link is initialized
    var self = this;
    return dsPromise.then(function() {
      return this._link.init()
        .then(function() {
          return this._link.connect();
        }.bind(this))
        .then(function() {
          return this._link.onRequesterReady;
        }.bind(this))
        .then(function(requester) {
          this.isConnected = true;
          this._requester = requester;
          this.list("/").then(function() { return self; });
        }.bind(this));
    }.bind(this));
  };

  DataTree.prototype.list = function(path, recursive) {
    // toggle on updates, populate with children
    if (Object.keys(this._deepListCache).indexOf(path) >= 0 && !this._deepListCache[path]) {
      this._deepListCache[path] = true;
      var node = this._map.get(path);
      if (!node) {
        return;
      }

      var promises = [];
      node.childrenNames.forEach(function(name) {
        var childPathPrefix = path == "/" ? "/" : (path + "/");
        promises.push(this.list(childPathPrefix + name, false));
      }.bind(this));

      if (promises.length) {
        Promise.all(promises)
          .then(this._update.bind(this))
          .catch(this._update.bind(this));
      }
      return;
    }

    recursive = recursive == null ? true : recursive;

    var completed = false;
    setTimeout(function() {
      if (completed) {
        return;
      }

      console.log("Listing " + path + " is taking a long time for dslink-javascript-util-data, please make sure the link is not quarantined.");
    }, 10000);

    var self = this;
    return dsPromise.then(function(DS) {
      var parentPath = path.trim() !== "/" ? (new DS.Path(path)).parent.path : null;

      return new Promise(function(resolve, reject) {
        var stream = this._requester.list(path);
        this._streamData(path, parentPath, stream, resolve, recursive);

        stream.once("close", function() {
          if (completed) {
            return;
          }

          reject(new Error("List node not found for " + path + " in dslink-javascript-util-data."));
        });
      }.bind(this)).then(function() {
        completed = true;
        return self;
      });
    }.bind(this))
      .catch(function(err) {
        console.log(err);
      });
  };

  try {
    if (module) {
      module.exports = {
        DataTree: DataTree
      }
    }
  } catch(e) {
    window.DSUtilData = {
      DataTree: DataTree
    };
  }
}

if (dsPromise) {
  init();
}

})();