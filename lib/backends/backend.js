var _ = require('lodash');
var Q = require('q');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var stream = require('stream');
var destroy = require('destroy');
var streamRes = require('stream-res');
var Buffer = require('buffer').Buffer;

// Simple disk cache backed by the filesystem (replaces lru-diskcache)
function DiskCache(cacheDir) {
    this.cacheDir = cacheDir;
}

DiskCache.prototype.init = function() {
    if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    return Q();
};

DiskCache.prototype._filePath = function(key) {
    var hash = crypto.createHash('sha256').update(String(key)).digest('hex');
    return path.join(this.cacheDir, hash);
};

DiskCache.prototype.has = function(key) {
    return fs.existsSync(this._filePath(key));
};

DiskCache.prototype.getStream = function(key) {
    return Q(fs.createReadStream(this._filePath(key)));
};

DiskCache.prototype.set = function(key, readable) {
    var that = this;
    var d = Q.defer();
    var filePath = this._filePath(key);
    var ws = fs.createWriteStream(filePath);
    readable.pipe(ws);
    ws.on('finish', function() { d.resolve(); });
    ws.on('error', function(err) {
        fs.unlink(filePath, function() {});
        d.reject(err);
    });
    return d.promise;
};

function Backend(nuts, opts) {
    this.cacheId = 0;
    this.nuts = nuts;
    this.opts = _.defaults(opts || {}, {
        // Folder to cache assets
        cache: path.resolve(os.tmpdir(), 'nuts'),

        // Cache configuration
        cacheMax: 500 * 1024 * 1024,
        cacheMaxAge: 60 * 60 * 1000,
    });

    // Create cache
    this.cache = new DiskCache(this.opts.cache);

    _.bindAll(this, ['memoize', 'onRelease', 'init', 'releases', 'serveAsset', 'getAssetStream', 'readAsset']);
}

// Memoize a function
Backend.prototype.memoize = function(fn) {
    var that = this;

    return _.memoize(fn, function() {
        return that.cacheId+Math.ceil(Date.now()/that.opts.cacheMaxAge)
    });
};

// New release? clear cache
Backend.prototype.onRelease = function() {
    this.cacheId++;
};

// Initialize the backend
Backend.prototype.init = function() {
    this.cache.init();
    return Q();
};

// List all releases for this repository
Backend.prototype.releases = function() {

};

// Return stream for an asset
Backend.prototype.serveAsset = function(asset, req, res) {
    var that = this;
    var cacheKey = asset.id;

    function outputStream(stream) {
        var d = Q.defer();
        streamRes(res, stream, d.makeNodeResolver());
        return d.promise;
    }

    res.header('Content-Length', asset.size);
    res.attachment(asset.filename);

    // Key exists
    if (that.cache.has(cacheKey)) {
        return that.cache.getStream(cacheKey)
            .then(outputStream);
    }

    return that.getAssetStream(asset)
    .then(function(assetStream) {
        // Tee the stream: one copy to cache, one copy to response
        var cachePass = new stream.PassThrough();
        var responsePass = new stream.PassThrough();
        assetStream.pipe(cachePass);
        assetStream.pipe(responsePass);
        return Q.all([
            // Cache the stream
            that.cache.set(cacheKey, cachePass),

            // Send the stream to the user
            outputStream(responsePass)
        ]);
    });
};

// Return stream for an asset
Backend.prototype.getAssetStream = function(asset) {

};

// Return stream for an asset
Backend.prototype.readAsset = function(asset) {
    return this.getAssetStream(asset)
    .then(function(res) {
        var d = Q.defer();
        var output = Buffer([]);

        function cleanup() {
            destroy(res);
            res.removeAllListeners();
        }

        res.on('data', function(buf) {
                output = Buffer.concat([output, buf]);
            })
            .on('error', function(err) {
                cleanup();
                d.reject(err);
            })
            .on('end', function() {
                cleanup();
                d.resolve(output);
            });

        return d.promise

    })
};

module.exports = Backend;
