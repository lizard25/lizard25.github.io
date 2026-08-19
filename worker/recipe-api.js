const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Recipe-Key",
  "Access-Control-Allow-Methods": "GET, OPTIONS, PUT"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const resource = request.url.includes("resource=improvements") ? "improvements" : "recipes";
    if (request.method === "GET") return getFile(env, resource);
    if (request.method === "PUT") return updateFile(request, env, resource);
    return json({ error: "Method not allowed" }, 405);
  }
};

async function getFile(env, resource) {
  const path = resourcePath(env, resource);
  const response = await githubRequest(env, `contents/${path}`);
  if (!response.ok) return githubError(response, `Could not read ${resource}`);
  const file = await response.json();
  const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (character) => character.charCodeAt(0))));
  return json({ [resource === "improvements" ? "improvements" : "recipes"]: data });
}

async function updateFile(request, env, resource) {
  if (!env.RECIPE_WRITE_KEY || request.headers.get("X-Recipe-Key") !== env.RECIPE_WRITE_KEY) {
    return json({ error: "Invalid recipe write key" }, 401);
  }

  const payload = await request.json();
  const field = resource === "improvements" ? "improvements" : "recipes";
  if (!Array.isArray(payload[field])) return json({ error: `${field} must be an array` }, 400);
  const path = resourcePath(env, resource);

  const currentResponse = await githubRequest(env, `contents/${path}`);
  if (!currentResponse.ok) return githubError(currentResponse, `Could not read current ${resource}`);
  const currentFile = await currentResponse.json();
  const content = `${JSON.stringify(payload[field], null, 2)}\n`;
  const updateResponse = await githubRequest(env, `contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Update ${resource}`,
      content: encodeBase64(content),
      sha: currentFile.sha,
      branch: env.GITHUB_BRANCH || "main"
    })
  });

  if (updateResponse.status === 409) return json({ error: `${resource} changed elsewhere. Reload and try again.` }, 409);
  if (!updateResponse.ok) return githubError(updateResponse, `Could not save ${resource}`);
  return json({ saved: true });
}

function resourcePath(env, resource) {
  return resource === "improvements" ? env.IMPROVEMENTS_PATH : env.RECIPE_PATH;
}

function githubRequest(env, path, options = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "recipe-book-worker",
      ...(options.headers || {})
    }
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function githubError(response, fallback) {
  let detail = fallback;
  try {
    const payload = await response.json();
    if (payload.message) detail = payload.message;
  } catch (error) {
    // Keep the fallback when GitHub does not return JSON.
  }
  return json({ error: detail, githubStatus: response.status }, response.status >= 500 ? 502 : response.status);
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}