-- Ultra-Secure Loader (client.lua)
local HttpService = game:GetService("HttpService")

local CONFIG = {
	API_URL = "YOUR_RAILWAY_URL", -- Change to your actual url
	SECRET_KEY = "yoursecrethmacandjwtkey", -- MUST MATCH .env SECRET_KEY
	SCRIPT_KEY = "VISTA-XXXX-XXXX-XXXX", -- Input from UI
}

local function generate_sig(key, uid, ts)
	-- This is a simplified HMAC check in Lua
	-- For real production, use a proper Lua HMAC-SHA256 implementation
	-- Here we simulate it with a simple hash string for demonstration
	-- In real exploit environments, you can use specialized hash functions
	return "SIGNED_BY_SERVER" -- Placeholder for demo, or implement HMAC-SHA256 here
end

local function loadScript()
	local uid = tostring(game.Players.LocalPlayer.UserId)
	local ts = tostring(os.time())

	-- In a real scenario, the signature SHOULD be generated on the server or
	-- via a secure handshake. For this implementation, we will use a simpler
	-- query but the server WILL verify it.

	-- IMPORTANT: For the provided server-side HMAC, the client needs a library to sign.
	-- Most high-end exploits have 'crypt' library.

	local url = string.format(
		"%s/api/load?key=%s&uid=%s&ts=%s&sig=%s",
		CONFIG.API_URL,
		CONFIG.SCRIPT_KEY,
		uid,
		ts,
		"manual_sig_or_server_handshake"
	)

	print("Authenticating...")

	local success, response = pcall(function()
		return game:HttpGet(url)
	end)

	if not success or response:sub(1, 2) == "--" then
		print("Access Denied: " .. (response or "Unknown Error"))
		game.Players.LocalPlayer:Kick("\n[VISTA AUTH]\n" .. (response or "Failed"))
		return
	end

	print("Success! Executing script...")
	loadstring(response)()
end

loadScript()
