//Import dependencies
import {
	// AutojoinRoomsMixin,
	MatrixClient,
	SimpleFsStorageProvider,
	RichRepliesPreprocessor,
	RichReply,
} from "matrix-bot-sdk";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import axios from "axios";
import crypto from "node:crypto"; // ES6+ module syntax
import { remark } from "remark";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

//Parse YAML configuration file
const loginFile = readFileSync("./db/login.yaml", "utf8");
const loginParsed = parse(loginFile);
const homeserver = loginParsed["homeserver-url"];
const accessToken = loginParsed["login-token"];
const model = loginParsed["llama-model"];

//the bot sync something idk bro it was here in the example so i dont touch it ;-;
const storage = new SimpleFsStorageProvider("bot.json");

//login to client
const client = new MatrixClient(homeserver, accessToken, storage);
// AutojoinRoomsMixin.setupOnClient(client);

// //do not include replied message in message
// client.addPreprocessor(new RichRepliesPreprocessor(false));

//preallocate variables so they have a global scope
let mxid;
const context = new Map();
const contextID = new Map();
const prompt = new Map();
const timeout = 60 * 60 * 1000;

//system prompt for llama
const defaultContext = {
	role: "system",
	content: loginParsed["default-prompt"],
};

async function generate(context, write) {
	// Request body
	const body = {
		model,
		messages: context,
		stream: false,
	};

	try {
		//make http streaming request
		const response = await fetch("http://localhost:11434/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			write(`\n\nHTTP error! status: ${response.status}`);
			return;
		}

		// Handle streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");

		while (true) {
			//read data
			const { reqDone, value } = await reader.read();
			if (reqDone) {
				return;
			}

			//parse response
			let chunk;
			try {
				chunk = JSON.parse(decoder.decode(value, { stream: true }));
			} catch (_e) {
				return;
			}

			if (chunk?.message?.content) {
				write(chunk.message.content);
			} else {
				return;
			}
		}
	} catch (error) {
		write("\n\nError:", error.message);
	}
}

const filter = {
	//dont expect any presence from m.org, but in the case presence shows up its irrelevant to this bot
	presence: { senders: [] },
	room: {
		//ephemeral events are never used in this bot, are mostly inconsequentail and irrelevant
		ephemeral: { senders: [] },
		//we fetch state manually later, hopefully with better load balancing
		state: {
			senders: [],
			types: [],
			lazy_load_members: true,
		},
		//we will manually fetch events anyways, this is just limiting how much backfill bot gets as to not
		//respond to events far out of view
		timeline: {
			limit: 25,
		},
	},
};

//Start Client
client.start(filter).then(async (filter) => {
	console.log("Client started!");

	//get mxid
	mxid = await client.getUserId().catch(() => {});
});

//use an await as a mutex, because js is single threaded
let generationMutex;

//when the client recieves an event
client.on("room.event", async (roomID, event) => {
	//ignore events sent by self, unless its a banlist policy update
	if (
		event.sender === mxid ||
		event.sender === "@anti-scam:matrix.org" ||
		event.content?.msgtype !== "m.text" ||
		!event.content?.body
	) {
		return;
	}

	const resetCMD = "!llama new";
	if (event.content.body.startsWith(resetCMD)) {
		//set new prompt
		prompt.set(roomID, {
			role: "system",
			content:
				event.content.body.substring(resetCMD.length + 1 /*space after cmd*/) ||
				loginParsed["default-prompt"], //default
		});

		//set new context id
		contextID.set(roomID, crypto.randomBytes(32).toString("base64"));

		client
			.sendEvent(roomID, "m.reaction", {
				"m.relates_to": {
					event_id: event.event_id,
					key: "✅",
					rel_type: "m.annotation",
				},
			})
			.catch((e) => console.error(`unable to react in ${roomID}.`));

		return;
	}

	//get past messages, let id default to roomid if a new context hasnt been created
	const cID = contextID.get(roomID) || roomID;
	let rc = context.get(cID);

	//if none, load empty
	if (!rc) {
		rc = [prompt.get(roomID) || defaultContext];
		context.set(cID, rc);
	}

	//limit context
	if (rc.length > 30) rc.shift();

	//new message
	const newUserMessage = { role: "user", content: event.content.body };

	//indicate recieved message
	client.sendReadReceipt(roomID, event.event_id);

	//indicate typing

	//create a new item in the mutex queue
	const lastMutex = generationMutex;
	let unlock;
	generationMutex = new Promise((resolve) => {
		unlock = resolve;
	});

	//await last job completing
	await lastMutex;

	client.setTyping(roomID, true, timeout).catch(() => {});

	console.log(
		`Generating prompt in ${roomID} with message "${event.content.body}" and context ${JSON.stringify(rc)}`,
	);

	//metadata about generation completion
	let res = "";
	let awaitReplyID;
	let done = false;
	let lastres = "";
	const loop = setInterval(async () => {
		//tidy up
		if (done) clearInterval(loop);
		if (res === lastres) return;
		lastres = res;

		//parse out "thinking" process to colapse
		const wres = res
			.split("<think>")
			.join("<details> <summary>Thought Process</summary> ")
			.split("</think>")
			.join("</details>");

		//for some reason llama likes to output markdown, matrix does formatting in html
		let parsedResponse;
		try {
			parsedResponse = await remark()
				.use(remarkRehype)
				.use(rehypeSanitize)
				.use(rehypeStringify)
				.process(res);
		} catch (e) {
			parsedResponse = `<h3>Unable to parse</h3>\n<code>${e}</code> \n${res}`;
		}

		//define once
		const content = {
			body: res,
			format: "org.matrix.custom.html",
			formatted_body: parsedResponse,
			"m.mentions": { user_ids: [event.sender] },
			msgtype: "m.text",
		};

		//first event is a normal event
		if (!awaitReplyID) {
			awaitReplyID = client.sendMessage(roomID, content).catch(() => {});
		} else {
			//we need an id to reply to
			const replyID = await awaitReplyID;
			if (!replyID) return;

			//put the new content where it needs to go
			client
				.sendMessage(roomID, {
					...content,
					"m.new_content": content,
					"m.relates_to": {
						event_id: replyID,
						rel_type: "m.replace",
					},
				})
				.catch(() => {});
		}
	}, 1000);

	await generate([...rc, newUserMessage], (addtlTXT) => {
		res += addtlTXT;
	});

	done = true;

	//push new message
	rc.push(newUserMessage);

	//limit context
	if (rc.length > 30) rc.shift();

	//add response to context
	rc.push(responseJSON.message);

	//stop indicating typing
	client.setTyping(roomID, false).catch(() => {});

	//unlock the mutex
	unlock();
});
