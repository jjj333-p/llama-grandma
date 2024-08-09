### llama-grandma

A simple matrix bot that will feed every message to your llama model of choice and respond in a room as if it is a grandma. Ive had good luck with llama3 on my laptop with an `AMD Ryzen 7 5825U with Radeon Graphics (16) @ 4.546GHz` and 16gb ram but no dgpu, llama2-uncensored was horrible. 

Requires ollama to already be running on localhost.

Copy `example/db.yaml` to `db/login.yaml` and fill in things

Run `!llama new ?<system prompt>` to clear context and add a new system prompt