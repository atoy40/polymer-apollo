/* eslint-disable no-param-reassign, func-names, no-console */
import omit from 'lodash.omit';

export class DollarApollo {
  constructor(el) {
    this.el = el;
    this.querySubscriptions = {};
    el.__apollo_store = {};
  }

  get client() {
    return this.el._apolloClient;
  }

  get query() {
    return this.client.query.bind(this.client);
  }

  get subscribe() {
    return this.client.subscribe.bind(this.client);
  }

  watchQuery(options) {
    const el = this.el;
    const observable = this.client.watchQuery(options);
    const _subscribe = observable.subscribe.bind(observable);
    observable.subscribe = (function (opt) {
      const sub = _subscribe(opt);

      const _unsubscribe = sub.unsubscribe.bind(sub);
      sub.unsubscribe = function () {
        _unsubscribe();
        el._apolloSubscriptions = el._apolloSubscriptions.filter(storeSub => storeSub !== sub);
      };

      el._apolloSubscriptions.push(sub);
      return sub;
    });

    return observable;
  }

  get mutate() {
    return this.client.mutate.bind(this.client);
  }

  processObservers(el) {
    // Create subscription
    const $apollo = this;
    this.el = el;
    for (const key of Object.keys(el.__apollo_store)) {
      el.cancelDebouncer(`__apollo_var_${key}`); // cancel variables changes
      const obj = el.__apollo_store[key];
      if (obj.options.skip === undefined) {
        $apollo._subscribeObservers(key, obj.options, obj.observer);
      }
    }
  }

  _subscribeObservers(key, options, observer) {
    const el = this.el;
    const $apollo = this;
    const loadingKey = options.loadingKey;
    let loadingChangeCb = options.watchLoading;

    this._changeLoader(loadingKey, true, loadingChangeCb);
    if (typeof loadingChangeCb === 'function') {
      loadingChangeCb = loadingChangeCb.bind(el);
    }

    // set initial value of variables
    if (options.variables) {
      for(let _var of Object.keys(options.variables)) {
        let _prop = options.variables[_var];
        options.variables[_var] = el.get(_prop);
      }
    }

    const sub = observer.subscribe({
      next: this._nextResultFn(key, options),
      error: this._catchErrorFn(key, options),
    });

    return sub;
  }

  _applyData(data, key, prop) {
    if (data[key] === undefined) {
      console.error(`Missing "${key}" in GraphQL data`, data);
    } else {
      const storeEntry = this.el.__apollo_store[key];
      if (storeEntry && !storeEntry.firstLoadingDone) {
        storeEntry.firstLoadingDone = true;
      }
      this.el[prop] = data[key];
    }
  }

  _changeLoader(loadingKey, value, loadingChangeCb) {
    if (loadingKey) {
      this.el[loadingKey] = value;
    }

    if (loadingChangeCb) {
      loadingChangeCb(value);
    }
  }

  _refetch(key, options, variables, observer) {
    const el = this.el;
    const $apollo = this;
    const loadingKey = options.loadingKey;
    let loadingChangeCb = options.watchLoading;

    this._changeLoader(loadingKey, true, loadingChangeCb);
    if (typeof loadingChangeCb === 'function') {
      loadingChangeCb = loadingChangeCb.bind(el);
    }

    observer.refetch().then(({ data }) => {
      this._changeLoader(options.loadingKey, false, options.watchLoading);
    }, this._catchErrorFn(key, options));
  }

  _nextResultFn(key, options) {
    // NetworkStatus { loading = 1, setVariables = 2, fetchMore = 3,
    //                 refetch = 4, poll = 6, ready = 7, error = 8 }
    // watchQuery options "notifyOnNetworkStatusChange" could be used by default
    // to get state changes and manage loading status better ?

    return ({ data, loading, networkStatus }) => {
      this._changeLoader(options.loadingKey, loading === undefined ? false : loading, options.watchLoading);
      if (networkStatus === undefined || networkStatus === 7) {
        this._applyData(data, options.dataKey, key);
      }
    };
  }

  _catchErrorFn(key, options) {
    return (error) => {
      this._changeLoader(options.loadingKey, false, options.watchLoading);
      if (error.graphQLErrors && error.graphQLErrors.length !== 0) {
        console.error(`GraphQL execution errors for query ${key}`);
        for (const e of error.graphQLErrors) {
          console.error(e);
        }
      } else if (error.networkError) {
        console.error(`Error sending the query ${key}`, error.networkError);
      } else {
        console.error(error);
      }
      if (typeof options.error === 'function') {
        options.error.apply(this.el, [error]);
      }
    };
  }

  _processVariables(key, options, sub, observer) {
    const variables = options.variables;
    if (options.forceFetch && observer) {
      // Refresh query
      this._refetch(key, options, variables, observer);
      return observer;
    }
    if (sub) {
      sub.unsubscribe();
    }

    // Create observer
    const newObserver = this.watchQuery(this._generateApolloOptions(options));
    this.el.__apollo_store[key] = { observer: newObserver, variables, options, firstLoadingDone: false };
    return newObserver;
  }

  refetch(key) {
    const obj = this.el.__apollo_store[key];
    if (obj) {
      this._refetch(key, obj.options, obj.variables, obj.observer);
    } else {
      console.error(`Unable to find a query with key : ${key}`);
    }
  }

  _generateApolloOptions(options) {
    const apolloOptions = omit(options, [
      'error',
      'loadingKey',
      'watchLoading',
      'skip',
      'dataKey',
    ]);
    return apolloOptions;
  }

  _addPolymerObserver(el, variable, observer) {
    const rand = Math.floor(1000000000 + (Math.random() * 9000000000));
    const rId = `__apollo_${rand}`;
    el[rId] = observer;
    el.observers = el.observers || [];
    el.observers.push(`__apollo_${rand}(${variable})`);
  }

  _processVariableChangesFn(key) {
    return () => {
      const storeEntry = this.el.__apollo_store[key];
      if (storeEntry.options.skip === true) {
        return;
      }
      storeEntry.observer.setVariables(storeEntry.updatedVariables);
      storeEntry.updatedVariables = {};
    }
  }

  process(key, options) {
    if (key && options) {
      const el = this.el;
      const $apollo = this;
      let sub;

      if (!options.dataKey) {
        options.dataKey = key;
      }

      const observer = this._processVariables(key, options, sub);

      if (options.skip !== undefined) {
        const _prop = options.skip;

        this._addPolymerObserver(el, _prop, function(newSkipValue) {
          this.debounce(`__apollo_skip_${key}`, () => {
            const storeEntry = el.__apollo_store[key];
            if (!newSkipValue) {
              storeEntry.options.skip = false;
              sub = $apollo._subscribeObservers(key, storeEntry.options, storeEntry.observer);
            } else {
              storeEntry.options.skip = true;
              if (sub) {
                sub.unsubscribe();
                sub = null;
              }
            }
          });
        });
        // assuming initial value is true.
        options.skip = true;
      }

      if (options.variables) {
        for(let _var of Object.keys(options.variables)) {
          let path = options.variables[_var];
          this._addPolymerObserver(el, path, function(newValue) {
            const storeEntry = this.__apollo_store[key];
            if (!storeEntry.updatedVariables) {
              storeEntry.updatedVariables = {};
            }
            storeEntry.updatedVariables[_var] = newValue;
            this.debounce(`__apollo_var_${key}`, $apollo._processVariableChangesFn(key));
          });
        }
      }
    }
  }
}

export class PolymerApollo {

  constructor(options) {
    this._apolloClient = options.apolloClient;
    this._apolloSubscriptions = [];
    this.properties = {};
  }

  beforeRegister() {
    const apollo = this.apollo;
    this.$apollo = new DollarApollo(this);

    if (apollo) {
      const queries = omit(apollo, [
        'subscribe',
      ]);

      // watchQuery
      for (const key of Object.keys(queries)) {
        this.$apollo.process(key, queries[key]);
      }
      // subscribe
      if (apollo.subscribe) {
        // TODO
      }
    }
  }

  attached() {
    this.$apollo.processObservers(this);
  }

  detached() {
    this._apolloSubscriptions.forEach((sub) => {
      sub.unsubscribe();
    });
    this._apolloSubscriptions = null;
    if (this.$apollo) {
      this.$apollo = null;
    }
  }
}
