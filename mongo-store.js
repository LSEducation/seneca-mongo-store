/* Copyright (c) 2010-2015 Richard Rodger, MIT License */
"use strict";


var _     = require('lodash')
var mongo = require('mongodb')


var name = "mongo-store"


/*
native$ = object => use object as query, no meta settings
native$ = array => use first elem as query, second elem as meta settings
*/


function idstr( obj ) {
  return ( obj && obj.toHexString ) ? obj.toHexString() : ''+obj
}


function makeid(hexstr) {
  if( _.isString(hexstr) && 24 == hexstr.length ) {
      return mongo.ObjectID.createFromHexString(hexstr)
  }

  return hexstr;
}


function fixquery(qent,q) {
  var qq = {};

  if( !q.native$ ) {
    for( var qp in q ) {
      if( !qp.match(/\$$/) ) {
        qq[qp] = q[qp]
      }
    }
    if( qq.id ) {
      qq._id = makeid(qq.id)
      delete qq.id
    }
  }
  else {
    qq = _.isArray(q.native$) ? q.native$[0] : q.native$
  }

  return qq
}


function metaquery(qent,q) {
  var mq = {}

  if( !q.native$ ) {

    if( q.sort$ ) {
      for( var sf in q.sort$ ) break;
      var sd = q.sort$[sf] < 0 ? 'descending' : 'ascending'
      mq.sort = [[sf,sd]]
    }

    if( q.limit$ ) {
      mq.limit = q.limit$
    }

    if( q.skip$ ) {
      mq.skip = q.skip$
    }

    if( q.fields$ ) {
      mq.fields = q.fields$
    }
  }
  else {
    mq = _.isArray(q.native$) ? q.native$[1] : mq
  }

  return mq
}




module.exports = function(opts) {
  var seneca = this
  var desc

  var dbinst  = null
  var clientinst = null
  var collmap = {}
  var specifications = null


  function error(args,err,cb) {
    if( err ) {
      seneca.log.error('entity',err,{store:name});
      cb(err);
      return true;
    }
    else return false;
  }



  function configure(spec,cb) {
    specifications = spec

    // defer connection
    // TODO: expose connection action
    if( !_.isUndefined(spec.connect) && !spec.connect ) {
      return cb()
    }


    var conf = 'string' == typeof(spec) ? null : spec

    if( !conf ) {
      conf = {}
      var urlM = /^mongo:\/\/((.*?):(.*?)@)?(.*?)(:?(\d+))?\/(.*?)$/.exec(spec);
      conf.name   = urlM[7]
      conf.port   = urlM[6]
      conf.server = urlM[4]
      conf.username = urlM[2]
      conf.password = urlM[3]

      conf.port = conf.port ? parseInt(conf.port,10) : null
    }


    conf.host = conf.host || conf.server
    conf.username = conf.username || conf.user
    conf.password = conf.password || conf.pass


    var dbopts = seneca.util.deepextend({
      native_parser:false,
      auto_reconnect:true,
      w:1
    },conf.options)


    if( conf.url ) {
      clientinst = new mongo.MongoClient( conf.url, dbopts )
    }
    else {
      clientinst = new mongo.MongoClient( new mongo.Server(conf.host, conf.port, dbopts ))
    }

    var topologyEvents = ['serverOpening', 'serverClosed', 'serverDescriptionChanged', 'topologyOpening', 'topologyClosed', 'topologyDescriptionChanged', 'serverHeartbeatFailed']
    _.each(topologyEvents, function(eventName) {
      clientinst.on(eventName, function (event) {
        seneca.log.info({dbName: conf.name, eventName: eventName, event: event})
      })
    })

    clientinst.connect(function(err, client){
      if( err ) {
        return seneca.die('open',err,conf);
      }
      dbinst = client.db(conf.name)
      cb(null)
    })
  }


  function getcoll(args,ent,cb) {
    var canon = ent.canon$({object:true})

    var collname = (canon.base?canon.base+'_':'')+canon.name

    if( !collmap[collname] ) {
      dbinst.collection(collname, function(err,coll){
        if( !error(args,err,cb) ) {
          collmap[collname] = coll
          cb(null,coll);
        }
      })
    }
    else {
      cb(null,collmap[collname])
    }
  }





  var store = {
    name:name,

    close: function(args,cb) {
      if(clientinst) {
        clientinst.close(cb)
      }
      else return cb();
    },


    save: function(args,cb) {
      var ent = args.ent

      var update = !!ent.id;

      getcoll(args,ent,function(err,coll){
        if( !error(args,err,cb) ) {
          var entp = {};

          var fields = ent.fields$()
          fields.forEach( function(field) {
            entp[field] = ent[field]
          })

          if( !update && void 0 != ent.id$ ) {
            entp._id = makeid(ent.id$)
          }

          if( update ) {
            var q = {_id:makeid(ent.id)}
            delete entp.id

            coll.update(q,{$set: entp}, {upsert:true},function(err,update){
              if( !error(args,err,cb) ) {
                seneca.log.debug('save/update',ent,desc)
                cb(null,ent)
              }
            })
          }
          else {
            coll.insertOne(entp,function(err,inserts){
              if( !error(args,err,cb) ) {
                ent.id = idstr( inserts.ops[0]._id )

                seneca.log.debug('save/insert',ent,desc)
                cb(null,ent)
              }
            })
          }
        }
      })
    },


    load: function(args,cb) {
      var qent = args.qent
      var q    = args.q

      getcoll(args,qent,function(err,coll){
        if( !error(args,err,cb) ) {
          var mq = metaquery(qent,q)
          var qq = fixquery(qent,q)

          coll.findOne(qq,mq,function(err,entp){
            if( !error(args,err,cb) ) {
              var fent = null;
              if( entp ) {
                entp.id = idstr( entp._id )
                delete entp._id;

                fent = qent.make$(entp);
              }

              seneca.log.debug('load',q,fent,desc)
              cb(null,fent);
            }
          });
        }
      })
    },


    list: function(args,cb) {
      var qent = args.qent
      var q    = args.q

      getcoll(args,qent,function(err,coll){
        if( !error(args,err,cb) ) {
          var mq = metaquery(qent,q)
          var qq = fixquery(qent,q)

          coll.find(qq,mq).toArray(function(err,items){
            if( !error(args,err,cb) ) {
              var list = []

              _.each(items, function(item){
                if( !error(args,err,cb) ) {
                  if( item ) {
                    var fent = null;
                    if( item ) {
                      item.id = idstr( item._id )
                      delete item._id;

                      fent = qent.make$(item);
                    }
                    list.push(fent)
                  }
                  else {
                    seneca.log.debug('list',q,list.length,list[0],desc)
                    cb(null,list)
                  }
                }
              })
            }
          })
        }
      })
    },


    remove: function(args,cb) {
      var qent = args.qent
      var q    = args.q

      var all  = q.all$ // default false
      var load  = _.isUndefined(q.load$) ? true : q.load$ // default true

      getcoll(args,qent,function(err,coll){
        if( !error(args,err,cb) ) {
          var qq = fixquery(qent,q)

          if( all ) {
            coll.findOneAndDelete(qq,function(err){
              seneca.log.debug('remove/all',q,desc)
              cb(err)
            })
          }
          else {
            var mq = metaquery(qent,q)
            coll.findOne(qq,mq).toArray(function(err,item){
              if( !error(args,err,cb) ) {
                if( item ) {
                  coll.findOneAndDelete({_id:item._id},function(err){
                    seneca.log.debug('remove/one',q,item,desc)

                    var ent = load ? item : null
                    cb(err,ent)
                  })
                }
                else cb(null)
              }
            })
          }
        }
      })
    },

    native: function(args,done) {
      dbinst.collection('seneca', function(err,coll){
        if( !error(args,err,done) ) {
          coll.findOne({},{},function(err,entp){
            if( !error(args,err,done) ) {
              done(null,dbinst)
            }
            else {
              done(err)
            }
          })
        }
        else {
          done(err)
        }
      })
    }
  }


  var meta = seneca.store.init(seneca,opts,store)
  desc = meta.desc


  seneca.add({init:store.name,tag:meta.tag},function(args,done){
    configure(opts,function(err){
      if( err ) return seneca.die('store',err,{store:store.name,desc:desc});
      return done();
    })
  })


  return {name:store.name,tag:meta.tag}
}












