import { Carbyne, CarbyneDirectoryStore }                                          from 'carbyne-db'
import { load }                                                                    from 'cheerio'
import { spawn }                                                                   from 'child_process'
import * as crypto                                                                 from 'crypto'
import * as express                                                                from 'express'
import { NextFunction, Request, Response }                                         from 'express'
import * as fs                                                                     from 'fs'
import * as http                                                                   from 'http'
import { IncomingMessage, ServerResponse }                                         from 'http'
import * as https                                                                  from 'https'
import * as beautify                                                               from 'js-beautify'
import * as net                                                                    from 'net'
import * as normalizeUrl                                                           from 'normalize-url'
import * as path                                                                   from 'path'
import { join }                                                                    from 'path'
import * as Prism                                                                    from 'prismjs'
import 'prismjs/components/prism-markdown'
import { get }                                                                        from 'request-promise-native'
import * as URL                                                                       from 'url-parse'
import { Api }                                                                        from './api'
import { md2html }                                                                    from './md2html'
import { DECRYPTION_CONFIRMATION_HEADER, TJSONAccount, TJSONBugReport, TJSONProject } from './types'
import Signals = NodeJS.Signals

const debug = require ( 'debug' ) (
	'hexazine'
)

debug.enabled = true

let shuttingDown = false

export async function safeShutdown () {
	if ( shuttingDown ) {
		debug ( 'already shutting down' )
		return
	} else {
		shuttingDown = true
	}

	debug ( 'shutting down hexazine safely' )
	debug (
		'we have %d server(s) to shutdown',
		servers.length
	)

	for ( let i = 0 ; i < servers.length ; i++ ) {
		await new Promise (
			(
				accept
			) => {
				const server = servers[ i ]

				server.destroy ( accept )
			}
		)
	}

	debug ( 'successfully shut down servers' )
}

const configLocation = fs.existsSync ( 'config.json' ) ? 'config.json' : 'config.default.json'

const config = JSON.parse (
	fs.readFileSync (
		configLocation,
		'utf8'
	).replace (
		/\s+\/\/.*$/gm,
		''
	).trim ()
)

debug ( 'Loaded config' )

interface ApiRequest extends Request {
	account? : TJSONAccount,
	rawBody? : string
}

export const db = new Carbyne ( new CarbyneDirectoryStore ( path.join (
	__dirname,
	'db'
) ) )

const app = express ()

const router = express.Router ()
const servers = []

const noAuthRoutes = [
	'/accounts/auth',
	'/accounts/new',
	'/health'
]

if ( config[ 'secret' ] ) {
	noAuthRoutes.push ( '/github' )
}

app.use (
	async (
		req : ApiRequest,
		res : Response,
		next : NextFunction
	) => {
		req.rawBody = ''
		req.setEncoding ( 'utf8' )

		req.on (
			'data',
			( chunk : string ) => {
				req.rawBody += chunk
			}
		)

		req.on (
			'end',
			() => {
				try {
					req.body = req.rawBody.length === 0 ? {} : JSON.parse ( req.rawBody )
				} catch {
					req.body = {}
				}

				next ()
			}
		)
	}
)

router.use (
	async (
		req : ApiRequest,
		res : Response,
		next : NextFunction
	) => {
		const censored = JSON.parse ( JSON.stringify ( req.body ) )

		if ( censored.hasOwnProperty ( 'password' ) ) {
			censored.password = '[censored]'
		}

		if ( censored.hasOwnProperty ( 'code' ) ) {
			censored.password = '[censored]'
		}

		debug (
			'%s: %s /api%s: %O',
			req.ip,
			req.method,
			req.url,
			censored
		)

		res.header (
			'Access-Control-Allow-Origin',
			'*'
		)

		res.header (
			'Access-Control-Allow-Headers',
			'*'
		)

		if ( req.method === 'OPTIONS' ) {
			res.status ( 200 )
			res.end ()
		} else {
			const headers = req.headers

			if ( noAuthRoutes.indexOf ( req.url ) !== -1 ) {
				next ()
			} else if ( req.url.startsWith ( '/projects/published/' ) && req.url.length > 20 ) {
				next ()
			} else if ( headers.hasOwnProperty ( 'token' ) ) {
				const token = <string> headers.token

				try {
					await Api.validateToken ( token )

					req.account = await Api.getAccount ( await Api.getOwner ( token ) )

					next ()
				} catch {
					res.json ( null )
				}
			} else {
				res.json ( null )
			}
		}
	}
)

router.post (
	'/accounts/auth',
	async (
		req : ApiRequest,
		res : Response
	) => {
		const body = req.body

		if ( body.hasOwnProperty ( 'username' ) && body.hasOwnProperty ( 'password' ) ) {
			try {
				res.json ( await Api.authenticate (
					body.username,
					body.password
				) )
			} catch {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.get (
	'/accounts/check',
	async (
		req : ApiRequest,
		res : Response
	) => {
		// this is not in the noAuthRoutes list, so the authorization check will automatically return null for us if the token's invalid

		res.json ( true )
	}
)

router.post (
	'/accounts/new',
	async (
		req : ApiRequest,
		res : Response
	) => {
		const body = req.body

		if ( body.hasOwnProperty ( 'username' ) && body.hasOwnProperty ( 'password' ) ) {
			try {
				await Api.createAccount (
					body.username,
					body.password
				)

				res.json ( await Api.token ( body.username ) )
			} catch {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.post (
	'/accounts/logout',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.logoutAccount ( req.account.username ) )
		} catch {
			res.json ( false )
		}
	}
)

router.get (
	'/projects',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.getProjects ( req.account.username ) )
		} catch {
			res.json ( null )
		}
	}
)

router.post (
	'/projects/new',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'name' ) && req.body.hasOwnProperty ( 'type' ) ) {
			if ( Number.isInteger ( req.body.type ) && req.body.type >= 0 && req.body.type <= 1 ) {
				try {
					res.json ( await Api.newProject (
						req.account.username,
						<string> req.body.name,
						req.body.type
					) )
				} catch {
					res.json ( false )
				}
			} else {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/projects/rename/:id',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'name' ) ) {
			try {
				res.json ( await Api.renameProject (
					req.account.username,
					+req.params.id,
					<string> req.body.name
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/projects/delete/:id',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'name' ) ) {
			try {
				res.json ( await Api.deleteProject (
					req.account.username,
					+req.params.id
				) )
			} catch {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.post (
	'/projects/import',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'url' ) ) {
			const url = URL ( normalizeUrl ( req.body.url ) )

			if ( url.hostname === 'jsfiddle.net' ) {
				debug ( 'project is JSFiddle' )

				const segments = url.pathname.slice ( 1 ).split ( path.sep )

				let fiddleId = ''
				let currentPop = segments.pop ()

				if ( +currentPop ) {
					debug (
						'fiddle has ID %s',
						currentPop
					)

					fiddleId = '/' + currentPop

					if ( segments.length < 1 ) { // can't have version without id
						res.json ( false )

						return
					}

					currentPop = segments.pop ()
				}

				if ( currentPop ) {
					fiddleId = currentPop + fiddleId
				} else {
					res.json ( false )

					return
				}

				if ( fiddleId ) {
					debug (
						'getting fiddle with ID %s',
						fiddleId
					)

					const jshellUrl = `https://fiddle.jshell.net/${fiddleId}/show/light`

					try {
						const result = await get (
							jshellUrl,
							{
								headers : {
									Referer : jshellUrl
								}
							}
						)

						if ( result ) {
							const $ = load (
								result,
								{
									normalizeWhitespace : true
								}
							)

							$ ( 'body > script:last-child' ).remove ()

							for ( const i of [
								'href',
								'src'
							] ) {
								$ ( `[${i}^="/"]` ).each (
									(
										_,
										elem
									) => {
										const element = $ ( elem )
										const attr = element.attr ( i )

										element.attr (
											i,
											( attr.startsWith ( '//' ) ? 'https:' : 'https://fiddle.jshell.net' ) + attr
										)

										if ( attr === '/css/result-light.css' ) {
											element.remove ()
										}
									}
								)
							}

							$ ( 'style, script' ).each (
								(
									_,
									elem
								) => {
									if ( elem.children.length > 0 ) {
										const text = elem.children[ 0 ]

										text.data = text.data.replace (
											/(["'`])\/\//g,
											'$1https://'
										)
									}
								}
							)

							try {
								await Api.newProject (
									req.account.username,
									`Imported: JSFiddle ${fiddleId}`,
									0,
									beautify.html_beautify (
										$.html (),
										{
											indent_inner_html : true,
											indent_with_tabs  : true,
											wrap_line_length  : 0,
											brace_style       : 'end-expand',
											preserve_newlines : false,
											extra_liners      : [ 'style' ]
										}
									)
								)

								debug ( 'success' )

								res.json ( true )
							} catch {
								debug ( 'failed to create new project' )

								res.json ( false )
							}
						} else {
							debug ( 'fiddle does not exist' )

							res.json ( false )
						}
					} catch {
						res.json ( false )
					}
				} else {
					debug ( 'invalid URL (?)' )

					res.json ( false )
				}
			} else {
				debug ( 'can\'t import' )

				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.get (
	'/projects/:id',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.getProject (
				req.account.username,
				+req.params.id
			) )
		} catch {
			res.json ( null )
		}
	}
)

router.post (
	'/projects/:id',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'code' ) ) {
			try {
				res.json ( await Api.setProjectCode (
					req.account.username,
					+req.params.id,
					req.body.code
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/projects/move/:id',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'delta' ) ) {
			try {
				res.json ( await Api.moveProject (
					req.account.username,
					+req.params.id,
					+req.body.delta
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.get (
	'/editorOptions',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.getEditorOptions ( req.account.username ) )
		} catch {
			res.json ( null )
		}
	}
)

router.post (
	'/editorOptions',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'options' ) ) {
			try {
				res.json ( await Api.setEditorOptions (
					req.account.username,
					req.body.options
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/editorOptions/reset',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.resetEditorOptions (
				req.account.username
			) )
		} catch {
			res.json ( false )
		}
	}
)

router.post (
	'/accounts/delete',
	async (
		req : ApiRequest,
		res : Response
	) => {
		const body = req.body

		if ( body.hasOwnProperty ( 'password' ) ) {
			try {
				await Api.validateCredentials (
					req.account.username,
					body.password
				)

				res.json ( await Api.deleteAccount (
					req.account.username
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/accounts/delete/:username',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			try {
				res.json ( await Api.deleteAccount ( req.params.username ) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.get (
	'/projects/published/:publishToken',
	async (
		req : ApiRequest,
		res : Response
	) => {
		res.header (
			'Content-Type',
			'text/html'
		)

		try {
			const project : TJSONProject = await Api.getPublished ( req.params.publishToken )

			let code

			if ( project.code.startsWith ( DECRYPTION_CONFIRMATION_HEADER ) ) {
				code = project.code.substr ( DECRYPTION_CONFIRMATION_HEADER.length )
			} else {
				code = project.code
			}

			let html

			switch ( project.type ) {
				case 0:
					html = code
					break
				case 1:
					html = md2html (
						code,
						project.name
					)
			}

			res.end (
				html,
				'utf8'
			)
		} catch ( e ) {
			res.end (
				'This project does not exist or has been unpublished. Ask the author for a new link.',
				'utf8'
			)
		}
	}
)

router.get (
	'/projects/published/:publishToken/source',
	async (
		req : ApiRequest,
		res : Response
	) => {
		res.header (
			'Content-Type',
			'text/html'
		)

		try {
			const project : TJSONProject = await Api.getPublished ( req.params.publishToken )
			let code

			if ( project.code.startsWith ( DECRYPTION_CONFIRMATION_HEADER ) ) {
				code = project.code.substr ( DECRYPTION_CONFIRMATION_HEADER.length )
			} else {
				code = project.code
			}

			let grammar
			let language

			switch ( project.type ) {
				case 0:
					grammar = Prism.languages.html
					language = 'html'
					break
				case 1:
					grammar = Prism.languages.markdown
					language = 'markdown'
			}

			const highlighted = Prism.highlight (
				code,
				grammar,
				language
			)

			res.end (
				'<link rel="stylesheet" type="text/css" href="/assets/prism.css">' + highlighted,
				'utf8'
			)
		} catch {
			res.end (
				'This project does not exist or has been unpublished. Ask the author for a new link.',
				'utf8'
			)
		}
	}
)

router.post (
	'/projects/:id/unpublish',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.unpublish (
				req.account.username,
				+req.params.id
			) )
		} catch {
			res.json ( false )
		}
	}
)

router.post (
	'/projects/:id/publish',
	async (
		req : ApiRequest,
		res : Response
	) => {
		try {
			res.json ( await Api.publish (
				req.account.username,
				+req.params.id
			) )
		} catch {
			res.json ( null )
		}
	}
)

router.post (
	'/bugReport',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if (
			req.body.hasOwnProperty ( 'title' ) &&
			req.body.hasOwnProperty ( 'summary' ) &&
			req.body.hasOwnProperty ( 'steps' ) &&
			req.body.hasOwnProperty ( 'comments' )
		) {
			try {
				res.json ( await Api.submitBugReport (
					req.account.username,
					<TJSONBugReport> {
						username : req.account.username,
						title    : req.body.title,
						summary  : req.body.summary,
						steps    : req.body.steps,
						comments : req.body.comments,
						read     : false
					}
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/accounts/changePassword',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'oldPassword' ) && req.body.hasOwnProperty ( 'password' ) ) {
			Api.getOwner ( <string> req.headers.token ).then (
				(
					username : string
				) => {
					Api.changePassword (
						username,
						req.body.oldPassword,
						req.body.password
					).then (
						res.json.bind ( res )
					).catch (
						res.json.bind ( res )
					)
				}
			).catch (
				() => res.json ( false )
			)
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/accounts/changeUsername',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'username' ) && req.body.hasOwnProperty ( 'password' ) ) {
			try {
				res.json ( await Api.changeUsername (
					req.account.username,
					req.body.username,
					req.body.password
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.get (
	'/isAdmin',
	async (
		req : ApiRequest,
		res : Response
	) => {
		res.json ( req.account.isAdmin )
	}
)

router.get (
	'/accounts',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			try {
				res.json ( await Api.getAccounts () )
			} catch {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.get (
	'/accounts/admin/:username',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			try {
				res.json ( await Api.getAccount ( req.params.username ) )
			} catch {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.post (
	'/accounts/admin/:username',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			try {
				res.json ( await Api.setAccount (
					req.params.username,
					req.body // holy fuck I hope the client knows what it's doing
				) )
			} catch {
				res.json ( false )
			}
		} else {
			res.json ( false )
		}
	}
)

router.post (
	'/accounts/checkPassword',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.body.hasOwnProperty ( 'password' ) ) {
			try {
				res.json ( await Api.validateCredentials (
					req.account.username,
					req.body.password
				) )
			} catch {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.get (
	'/bugReports',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			try {
				res.json ( await Api.getBugReports () )
			} catch {
				res.json ( null )
			}
		}
	}
)

router.post (
	'/bugReports/:id',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			try {
				res.json ( await Api.setBugReport (
					req.params.id,
					req.body
				) )
			} catch {
				res.json ( false )
			}
		}
	}
)

function signature ( body ) {
	return crypto.createHmac (
		'sha1',
		config.secret
	).update ( body ).digest ( 'hex' )
}

if ( config[ 'secret' ] ) {
	router.post (
		'/github',
		async (
			req : ApiRequest,
			res : Response
		) => {
			if (
				req.headers.hasOwnProperty ( 'x-github-event' ) &&
				req.headers.hasOwnProperty ( 'x-github-delivery' ) &&
				req.headers.hasOwnProperty ( 'x-hub-signature' ) &&
				req.headers.hasOwnProperty ( 'user-agent' ) &&
				( <string> req.headers[ 'user-agent' ] ).startsWith ( 'GitHub-Hookshot/' )
			) {
				debug ( 'got webhook ping from "GitHub" (need to validate first)' )
				debug ( 'calculating signature of request body' )
				const sig = signature ( req.rawBody )

				debug (
					'signature is %o',
					sig
				)

				if ( ( <string> req.headers[ 'x-hub-signature' ] ) === 'sha1=' + sig ) {
					const event = <string> req.headers[ 'x-github-event' ]

					debug (
						'signature matches, event is %s',
						event
					)

					if ( ( event ) === 'push' ) { // guaranteed to be committed after backend
						res.status ( 200 )
						res.json ( true )

						if ( req.body.ref === 'refs/heads/' + config.branch ) {

							debug ( 'executing update script' )

							const child = spawn (
								'bash',
								[
									join (
										__dirname,
										'update.sh'
									)
								]
							)

							child.stdout.on (
								'data',
								( data ) => process.stdout.write ( data.toString () )
							)

							child.stderr.on (
								'data',
								( data ) => process.stderr.write ( data.toString () )
							)

							child.on (
								'close',
								async (
									code : number,
									signal : string
								) => {
									debug ( 'execution completed' )

									if ( code !== 0 ) {
										debug (
											'exit status was non-zero: %d (signal: %s)',
											code,
											signal
										)

										debug ( 'bringing down servers for update' )
									} else {
										debug (
											'exit status was zero (signal: %s)',
											signal
										)
									}

									await safeShutdown ()

									debug ( 'stopping hexazine' )

									process.exit ( 1 )
								}
							)
						} else {
							debug ( 'assuming backend has been pushed and master will follow' )
						}
					} else if ( event === 'ping' ) {
						debug ( 'ping event successfully received' )

						res.status ( 200 )
						res.json ( true )
					} else {
						debug ( 'unsupported event' )

						res.status ( 400 )
						res.json ( false )
					}
				} else {
					debug ( 'signature doesn\'t match' )

					res.status ( 403 )
					res.json ( false )
				}
			} else {
				debug ( 'not a valid GitHub event' )

				res.status ( 400 )
				res.json ( false )
			}
		}
	)
}

router.get (
	'/health',
	async (
		req : ApiRequest,
		res : Response
	) => {
		res.json ( true )
	}
)

router.get (
	'/starterCode/:type',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			const type = +req.params.type

			if ( Number.isInteger ( type ) && type >= 0 && type <= 1 ) {
				res.json ( await Api.getStarterCode ( type ) )
			} else {
				res.json ( null )
			}
		} else {
			res.json ( null )
		}
	}
)

router.post (
	'/starterCode/:type',
	async (
		req : ApiRequest,
		res : Response
	) => {
		if ( req.account.isAdmin ) {
			if ( req.body.hasOwnProperty ( 'code' ) ) {
				const type = +req.params.type

				if ( Number.isInteger ( type ) && type >= 0 && type <= 1 ) {
					res.json ( await Api.setStarterCode (
						type,
						req.body.code
					) )
				} else {
					res.json ( null )
				}
			}
		} else {
			res.json ( null )
		}
	}
)

router.use (
	(
		err : Error,
		req : Request,
		res : Response,
		next : NextFunction
	) => {
		res.json ( err )
	}
)

app.use (
	'/api',
	router
)

process.on (
	'unhandledRejection',
	e => console.log ( e )
)

for ( const name of <Signals[]> [
	'SIGINT', // CTRL+C
	'SIGTERM', // `kill` command
	'SIGUSR1', // `kill` command
	'SIGUSR2' // `kill` command
] ) {
	process.on (
		name,
		async () => {
			debug (
				'recieved %s',
				name
			)

			await safeShutdown ()
		}
	)
}

app.use ( express.static ( 'app' ) )

app.get (
	'*',
	(
		req : Request,
		res : Response
	) => {
		res.sendFile ( path.resolve (
			__dirname,
			'./app/index.html'
		) )
	}
)

const port = config.port > 0 ? config.port : undefined

if ( fs.existsSync ( './privatekey.pem' ) && fs.existsSync ( './certificate.crt' ) ) {
	if ( port ) {
		debug (
			'using HTTPS on port %d',
			port
		)

		servers.push (
			net.createServer (
				( con ) => {
					con.once (
						'data',
						( buffer ) => {
							// If `buffer` starts with 22, it's a TLS handshake
							const proxyPort = port + ( buffer[ 0 ] === 22 ? 1 : 2 )
							const proxy = net.createConnection (
								proxyPort,
								'localhost',
								() => {
									proxy.write ( buffer )
									con.pipe ( proxy ).pipe ( con )
								}
							)
						}
					)
				}
			).listen (
				port,
				'0.0.0.0',
				() => debug ( 'proxy server has started' )
			)
		)
	} else {
		debug ( 'using HTTPS on default ports' )
	}

	servers.push (
		https.createServer (
			{
				key  : fs.readFileSync ( './privatekey.pem' ),
				cert : fs.readFileSync ( './certificate.crt' )
			},
			app
		).listen (
			( port || 442 ) + 1, // fancy way of saying port + 1 or 443
			port ? 'localhost' : '0.0.0.0',
			() => debug ( 'https server has started' )
		)
	)

	servers.push (
		http.createServer (
			(
				req : IncomingMessage,
				res : ServerResponse
			) => {
				res.writeHead (
					301,
					{
						Location : 'https://' + req.headers.host + req.url
					}
				)

				res.end ()
			}
		).listen (
			( port || 78 ) + 2, // fancy way of saying port + 2 or 80
			port ? 'localhost' : '0.0.0.0',
			() => debug ( 'http server has started' )
		)
	)
} else {
	debug (
		'using insecure HTTP on port %d',
		port || 80
	)

	servers.push (
		app.listen (
			port || 80,
			'0.0.0.0',
			() => debug ( 'server has started' )
		)
	)
}

servers.forEach ( require ( 'server-destroy' ) )
