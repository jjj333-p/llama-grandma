//Import dependencies
import {
	// AutojoinRoomsMixin,
	MatrixClient,
	SimpleFsStorageProvider,
	RichRepliesPreprocessor,
} from "matrix-bot-sdk";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import axios from "axios";
import crypto from "node:crypto"; // ES6+ module syntax

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

async function generate(messages, roomID) {
	//generate chat context
	const context = [prompt.get(roomID) || defaultContext];
	if (messages) context.push(...messages);

	// Request body
	const body = {
		model,
		messages: context,
		stream: false,
	};

	try {
		// Make request
		const response = await axios.post("http://localhost:11434/api/chat", body, {
			timeout,
		});

		// Return the response data
		return response.data;
	} catch (error) {
		console.error("Error fetching data:", error);
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
			content: event.content.body.substring(
				resetCMD.length + 1 /*space after cmd*/,
			),
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
		rc = [];
		context.set(cID, rc);
	}

	//limit context
	if (rc.length > 30) rc.shift();

	//new message
	const newUserMessage = { role: "user", content: event.content.body };

	//indicate recieved message
	client.sendReadReceipt(roomID, event.event_id);

	//indicate typing
	client.setTyping(roomID, true, timeout).catch(() => {});

	console.log(
		`Generating prompt in ${roomID} with message "${event.content.body}" and context ${JSON.stringify(rc)}`,
	);
	const responseJSON = await generate([...rc, newUserMessage], roomID);

	//stop indicating typing
	client.setTyping(roomID, false).catch(() => {});

	//no response
	if (!responseJSON) return console.error("empty response returned from LLM.");

	//error response
	if (responseJSON.error) return console.error(responseJSON.error);

	//broken response
	if (!responseJSON.message?.content)
		return console.error("No message returned in response from LLM.");

	//push new message
	rc.push(newUserMessage);

	//limit context
	if (rc.length > 30) rc.shift();

	//add response to context
	rc.push(responseJSON.message);

	//send reply
	if (responseJSON.message.content === "\n\n") {
		client
			.sendEvent(roomID, "m.reaction", {
				"m.relates_to": {
					event_id: event.event_id,
					key: "👍",
					rel_type: "m.annotation",
				},
			})
			.catch((e) => console.error(`unable to react in ${roomID}.`));
	} else if (responseJSON.message.content === "\n\n\n\n") {
		client
			.sendEvent(roomID, "m.reaction", {
				"m.relates_to": {
					event_id: event.event_id,
					key: "👎",
					rel_type: "m.annotation",
				},
			})
			.catch((e) => console.error(`unable to react in ${roomID}.`));
	} else {
		client
			.replyText(roomID, event, responseJSON.message.content)
			.catch((e) => console.error(`unable to message in ${roomID}.`));
	}
});
